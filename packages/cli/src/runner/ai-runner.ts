import type { ScoutConfig } from "../config.js";
import { inferProvider } from "../credentials.js";
import type { Scenario, Step, Verdict } from "../types.js";
import { createScoutTools } from "./agent-tools.js";
import { selectEngine } from "./engines/index.js";
import {
  describeNoVerdict,
  relativizeUrl,
  type AiRunOutcome,
  type QueryEndInfo,
} from "./engines/types.js";
import { BrowserSession } from "./browser.js";

// Re-exported from their new home so existing importers (src/index.ts, callers)
// keep working unchanged.
export { describeNoVerdict, relativizeUrl };
export type { AiRunOutcome, QueryEndInfo };

/**
 * AI-driven run, engine-neutral orchestrator. A Claude agent (via the Agent SDK
 * by default, or the Vercel AI SDK when selected) navigates the real browser to
 * verify the scenario. Every successful action is recorded as a deterministic
 * Step so subsequent runs can replay without the LLM.
 *
 * Verdict capture, the forced-verdict rescue, and outcome assembly live HERE,
 * above both engines, so behavior is identical regardless of engine.
 */
export async function runWithAgent(
  session: BrowserSession,
  scenario: Scenario,
  config: ScoutConfig
): Promise<AiRunOutcome> {
  const steps: Step[] = [];
  const transcript: string[] = [];
  let verdict: { verdict: Verdict; reason: string } | undefined;

  const tools = createScoutTools({
    session,
    config,
    record: (step) => steps.push(step),
    setVerdict: (v) => {
      verdict = v;
    },
  });

  const profileInfo = scenario.profile
    ? `Sessão autenticada com o profile "${scenario.profile}"${config.profiles[scenario.profile]?.description ? ` (${config.profiles[scenario.profile].description})` : ""}. Você JÁ está logado — não faça login de novo a menos que o cenário peça.`
    : "Sessão anônima (logged-out).";

  const envVars = scenario.profile ? (config.profiles[scenario.profile]?.env ?? []) : [];
  const envInfo = envVars.length
    ? `Env vars disponíveis via placeholder $ENV:VAR (em browser_fill e em URLs de browser_navigate): ${envVars.map((v) => `$ENV:${v}`).join(", ")}.`
    : "";

  const systemPrompt = `Você é Scout, um agente de QA que verifica cenários em um browser real.

App alvo: ${config.baseUrl}
${profileInfo}
${envInfo}

Método de trabalho:
1. Comece com browser_navigate para a página inicial do fluxo (ou browser_snapshot se já estiver lá).
2. Execute o fluxo descrito no cenário, passo a passo, sempre lendo o snapshot antes de agir.
3. Para CADA expectativa do cenário, use browser_assert — as asserções gravadas viram o teste determinístico que rodará em CI sem você.
4. Quando o cenário menciona logs/erros de console ou chamadas de rede/API: use browser_inspect_logs para ver o que ocorreu, depois browser_assert_network e/ou browser_assert_no_console_errors para gravar a verificação.
5. Capture browser_screenshot como evidência nos momentos-chave.
6. Termine SEMPRE com scout_verdict:
   - verified: todo o comportamento esperado foi confirmado por asserções
   - failed: comportamento esperado está quebrado (descreva exatamente o quê)
   - partial: parte funciona, parte não, ou não foi possível verificar tudo
   - blocked: não conseguiu nem chegar ao fluxo (app fora do ar, login quebrado, etc.)

Regras:
- Aja como um usuário real: um passo de cada vez, espere carregamentos com browser_wait_for.
- Se um elemento não está no snapshot, tire novo snapshot ou role o fluxo de outro jeito — não invente refs.
- Nunca use segredos literais: use $ENV:VAR_NAME — vale tanto em browser_fill quanto em URLs de browser_navigate (ex: tokens na query string).
- Não re-preencha um campo que você já preencheu, a menos que a página tenha limpado o valor — cada ação sua vira um passo do script gravado, e passos duplicados são ruído que fragiliza o replay.
- Asserções de rede/console devem ser TOLERANTES: case requests por método + padrão de URL + status; só use responseIncludes com trechos estáveis (nomes de campos), nunca ids/timestamps. Asserção colada a valor volátil quebra no replay.
- Seja econômico: não explore além do cenário. Seu orçamento é de ${config.maxTurns} ações.
- Se você está repetindo tentativas sem progresso (overlay bloqueando, elemento que não aparece), PARE e chame scout_verdict (partial ou blocked) explicando o obstáculo — um veredito parcial vale mais que morrer sem veredito.`;

  const userPrompt = `Verifique este cenário de QA:\n\n## ${scenario.name}\n\n${scenario.scenario}${scenario.notes ? `\n\nNotas: ${scenario.notes}` : ""}`;

  const provider = inferProvider(config.model);
  const engine = selectEngine(provider, config.engine);
  const run = await engine.run({
    provider,
    model: config.model,
    systemPrompt,
    userPrompt,
    tools,
    maxTurns: config.maxTurns,
  });
  transcript.push(...run.transcript);
  let endInfo: QueryEndInfo | undefined = run.end;

  // Forced-verdict rescue: the agent died mute (typically error_max_turns).
  // Resume the same session with a tiny turn budget and demand scout_verdict
  // with whatever it observed — a partial verdict beats a silent death.
  const mainCause = verdict ? undefined : describeNoVerdict(endInfo, config.maxTurns);
  if (!verdict) {
    transcript.push(
      `[scout] Agente encerrou sem veredito (${mainCause}) — resgate: exigindo scout_verdict com o que foi observado.`
    );
    try {
      const rescue = await run.resume(
        "Sua verificação atingiu o limite de ações. NÃO execute mais nenhuma ação de browser. Chame scout_verdict AGORA com base no que você já observou: 'partial' se a verificação ficou incompleta, 'blocked' se você nem chegou ao fluxo, 'failed'/'verified' apenas se já tinha evidência suficiente.",
        4
      );
      transcript.push(...rescue.transcript);
      endInfo = rescue.end;
    } catch (error) {
      transcript.push(`[scout] Resgate de veredito falhou: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!verdict) {
    const cause = mainCause ?? describeNoVerdict(endInfo, config.maxTurns);
    return {
      verdict: "blocked",
      reason: `Falha do RUNNER, não veredito de UI: ${cause}; scout_verdict não foi chamado nem no resgate de veredito.`,
      steps,
      transcript,
      runnerFailure: cause,
    };
  }

  return { ...verdict, steps, transcript };
}
