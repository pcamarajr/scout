import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ScoutConfig } from "../config.js";
import type { Scenario, Step, Verdict } from "../types.js";
import { BrowserSession, resolveEnvValue } from "./browser.js";

export interface AiRunOutcome {
  verdict: Verdict;
  reason: string;
  steps: Step[];
  transcript: string[];
  /**
   * Set when the runner itself failed to produce a verdict (agent never called
   * scout_verdict) — NOT a UI judgment. Callers may retry and must report it
   * as an infrastructure failure, never as "the scenario is blocked by the UI".
   */
  runnerFailure?: string;
}

/** How the SDK query ended, for no-verdict diagnostics. */
export interface QueryEndInfo {
  subtype: string;
  numTurns?: number;
  errors?: string[];
}

/**
 * Human-readable cause for a run that ended without scout_verdict.
 * Distinguishes runner-infrastructure causes (turn budget, SDK errors) from
 * an agent that simply stopped talking.
 */
export function describeNoVerdict(end: QueryEndInfo | undefined, maxTurns: number): string {
  if (!end) return "a sessão do agente terminou sem emitir resultado (subprocesso morreu?)";
  switch (end.subtype) {
    case "error_max_turns":
      return `o agente estourou o limite de ${maxTurns} turns sem chamar scout_verdict`;
    case "error_during_execution":
      return `erro durante a execução do agente${end.errors?.length ? `: ${end.errors.join("; ")}` : ""}`;
    case "success":
      return "o agente encerrou normalmente sem chamar scout_verdict";
    default:
      return `a sessão do agente terminou com "${end.subtype}"${end.errors?.length ? `: ${end.errors.join("; ")}` : ""}`;
  }
}

/**
 * Records navigation relative to the configured baseUrl so cached scripts
 * survive --base-url / SCOUT_BASE_URL pointing at another server. URLs that
 * merely share the prefix (http://localhost:3000x) or live on other hosts
 * stay absolute.
 */
export function relativizeUrl(url: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (url === base || url === `${base}/`) return "/";
  if (url.startsWith(base)) {
    const rest = url.slice(base.length);
    if (rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")) return rest;
  }
  return url;
}

/**
 * AI-driven run: a Claude agent navigates the real browser to verify the
 * scenario. Every successful action is recorded as a deterministic Step so
 * subsequent runs can replay without the LLM.
 */
export async function runWithAgent(
  session: BrowserSession,
  scenario: Scenario,
  config: ScoutConfig
): Promise<AiRunOutcome> {
  const steps: Step[] = [];
  const transcript: string[] = [];
  let verdict: { verdict: Verdict; reason: string } | undefined;

  const record = (step: Step) => steps.push(step);

  const afterAction = async (): Promise<string> => {
    const snap = await session.snapshot();
    return session.formatSnapshot(snap);
  };

  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const fail = (error: unknown) => ({
    content: [{ type: "text" as const, text: `ERRO: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  const browserServer = createSdkMcpServer({
    name: "browser",
    version: "1.0.0",
    tools: [
      tool(
        "browser_navigate",
        "Navega para uma URL (absoluta ou relativa ao baseUrl do app). Para tokens/segredos na URL use placeholder $ENV:VAR_NAME — resolvido em runtime, nunca passa por você.",
        { url: z.string().describe("Ex: /login, /renovar?token=$ENV:TOKEN ou https://...") },
        async ({ url }) => {
          try {
            await session.navigate(url);
            record({ kind: "navigate", url: relativizeUrl(url, config.baseUrl) });
            return ok(await afterAction());
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_snapshot",
        "Retorna o estado atual da página: URL, título, elementos interativos numerados [ref] e texto visível. Use sempre que precisar decidir a próxima ação.",
        {},
        async () => {
          try {
            return ok(await afterAction());
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_click",
        "Clica no elemento identificado pelo [ref] do último snapshot.",
        { ref: z.number().int().describe("Ref numérico do snapshot") },
        async ({ ref }) => {
          try {
            const target = await session.click(ref);
            record({ kind: "click", target });
            return ok(`Cliquei em ${target.description}.\n\n${await afterAction()}`);
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_fill",
        "Preenche um campo. Para credenciais/segredos use placeholder $ENV:VAR_NAME — o valor real vem do ambiente e nunca passa por você.",
        {
          ref: z.number().int(),
          value: z.string().describe("Texto literal ou $ENV:VAR_NAME"),
        },
        async ({ ref, value }) => {
          try {
            const target = await session.fill(ref, resolveEnvValue(value));
            record({ kind: "fill", target, value });
            return ok(`Preenchi ${target.description}.`);
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_select",
        "Seleciona uma opção em um <select> pelo value ou label.",
        { ref: z.number().int(), value: z.string() },
        async ({ ref, value }) => {
          try {
            const target = await session.select(ref, resolveEnvValue(value));
            record({ kind: "select", target, value });
            return ok(`Selecionei "${value}" em ${target.description}.\n\n${await afterAction()}`);
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_press",
        "Pressiona uma tecla (Enter, Escape, Tab, ArrowDown...).",
        { key: z.string() },
        async ({ key }) => {
          try {
            await session.press(key);
            record({ kind: "press", key });
            return ok(await afterAction());
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_wait_for",
        "Espera texto aparecer na página OU a URL conter um trecho. Use após ações que disparam carregamento.",
        {
          text: z.string().optional().describe("Texto que deve ficar visível"),
          urlContains: z.string().optional().describe("Trecho esperado na URL"),
        },
        async ({ text, urlContains }) => {
          try {
            if (text) {
              await session.waitForText(text);
              record({ kind: "waitForText", text });
            }
            if (urlContains) {
              await session.waitForUrl(urlContains);
              record({ kind: "waitForUrl", pattern: urlContains });
            }
            return ok(await afterAction());
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_assert",
        "Registra uma verificação do comportamento esperado. Use para CADA expectativa do cenário — essas asserções viram o teste determinístico.",
        {
          visibleText: z.string().optional().describe("Texto que DEVE estar visível"),
          notVisibleText: z.string().optional().describe("Texto que NÃO deve estar visível"),
          urlContains: z.string().optional().describe("Trecho que a URL deve conter"),
        },
        async ({ visibleText, notVisibleText, urlContains }) => {
          try {
            if (visibleText) {
              await session.assertVisible(visibleText);
              record({ kind: "assertVisible", text: visibleText });
            }
            if (notVisibleText) {
              await session.assertNotVisible(notVisibleText);
              record({ kind: "assertNotVisible", text: notVisibleText });
            }
            if (urlContains) {
              await session.assertUrl(urlContains);
              record({ kind: "assertUrl", pattern: urlContains });
            }
            return ok("Asserção passou.");
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "browser_screenshot",
        "Captura screenshot como evidência. Use em momentos-chave (estado final, paywall, erro encontrado).",
        { label: z.string().describe("Rótulo curto, ex: 'paywall-exibido'") },
        async ({ label }) => {
          try {
            await session.screenshot(label);
            record({ kind: "screenshot", label });
            return ok(`Screenshot "${label}" salvo.`);
          } catch (e) {
            return fail(e);
          }
        }
      ),
      tool(
        "scout_verdict",
        "OBRIGATÓRIO ao final: registra o veredito da verificação. Após chamar, encerre.",
        {
          verdict: z.enum(["verified", "failed", "partial", "blocked"]),
          reason: z.string().describe("Justificativa objetiva, citando o que foi observado"),
        },
        async (args) => {
          verdict = args;
          return ok("Veredito registrado. Encerre agora.");
        }
      ),
    ],
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
4. Capture browser_screenshot como evidência nos momentos-chave.
5. Termine SEMPRE com scout_verdict:
   - verified: todo o comportamento esperado foi confirmado por asserções
   - failed: comportamento esperado está quebrado (descreva exatamente o quê)
   - partial: parte funciona, parte não, ou não foi possível verificar tudo
   - blocked: não conseguiu nem chegar ao fluxo (app fora do ar, login quebrado, etc.)

Regras:
- Aja como um usuário real: um passo de cada vez, espere carregamentos com browser_wait_for.
- Se um elemento não está no snapshot, tire novo snapshot ou role o fluxo de outro jeito — não invente refs.
- Nunca use segredos literais: use $ENV:VAR_NAME — vale tanto em browser_fill quanto em URLs de browser_navigate (ex: tokens na query string).
- Não re-preencha um campo que você já preencheu, a menos que a página tenha limpado o valor — cada ação sua vira um passo do script gravado, e passos duplicados são ruído que fragiliza o replay.
- Seja econômico: não explore além do cenário. Seu orçamento é de ${config.maxTurns} ações.
- Se você está repetindo tentativas sem progresso (overlay bloqueando, elemento que não aparece), PARE e chame scout_verdict (partial ou blocked) explicando o obstáculo — um veredito parcial vale mais que morrer sem veredito.`;

  const baseOptions = {
    model: config.model,
    systemPrompt,
    mcpServers: { browser: browserServer },
    allowedTools: ["mcp__browser__*"],
    tools: [] as [],
    settingSources: [] as [],
    permissionMode: "bypassPermissions" as const,
  };

  let sessionId: string | undefined;
  let endInfo: QueryEndInfo | undefined;

  /** Drains a query, collecting transcript/session/end info. Always aborts at the end so no claude-agent-sdk subprocess outlives the run. */
  const drain = async (q: ReturnType<typeof query>, controller: AbortController): Promise<void> => {
    try {
      for await (const message of q) {
        if ("session_id" in message && message.session_id) sessionId = message.session_id;
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) transcript.push(block.text.trim());
          }
        }
        if (message.type === "result") {
          endInfo = {
            subtype: message.subtype,
            numTurns: message.num_turns,
            errors: "errors" in message ? message.errors : undefined,
          };
          break;
        }
      }
    } finally {
      controller.abort();
    }
  };

  const mainController = new AbortController();
  try {
    await drain(
      query({
        prompt: `Verifique este cenário de QA:\n\n## ${scenario.name}\n\n${scenario.scenario}${scenario.notes ? `\n\nNotas: ${scenario.notes}` : ""}`,
        options: { ...baseOptions, maxTurns: config.maxTurns, abortController: mainController },
      }),
      mainController
    );
  } catch (error) {
    endInfo = { subtype: "sdk_error", errors: [error instanceof Error ? error.message : String(error)] };
  }

  // Forced-verdict rescue: the agent died mute (typically error_max_turns).
  // Resume the same session with a tiny turn budget and demand scout_verdict
  // with whatever it observed — a partial verdict beats a silent death.
  const mainCause = verdict ? undefined : describeNoVerdict(endInfo, config.maxTurns);
  if (!verdict && sessionId) {
    transcript.push(
      `[scout] Agente encerrou sem veredito (${mainCause}) — resgate: exigindo scout_verdict com o que foi observado.`
    );
    const rescueController = new AbortController();
    try {
      await drain(
        query({
          prompt:
            "Sua verificação atingiu o limite de ações. NÃO execute mais nenhuma ação de browser. Chame scout_verdict AGORA com base no que você já observou: 'partial' se a verificação ficou incompleta, 'blocked' se você nem chegou ao fluxo, 'failed'/'verified' apenas se já tinha evidência suficiente.",
          options: { ...baseOptions, maxTurns: 4, resume: sessionId, abortController: rescueController },
        }),
        rescueController
      );
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
