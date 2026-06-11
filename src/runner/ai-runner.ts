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
        "Navega para uma URL (absoluta ou relativa ao baseUrl do app).",
        { url: z.string().describe("Ex: /login ou https://...") },
        async ({ url }) => {
          try {
            await session.navigate(url);
            // Grava relativo quando a URL está sob o baseUrl — o script
            // precisa sobreviver a SCOUT_BASE_URL apontando pra outro ambiente.
            const base = config.baseUrl.replace(/\/+$/, "");
            const recorded = url.startsWith(base) ? url.slice(base.length) || "/" : url;
            record({ kind: "navigate", url: recorded });
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
    ? `Env vars disponíveis para browser_fill via placeholder: ${envVars.map((v) => `$ENV:${v}`).join(", ")}.`
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
- Nunca digite segredos literais: use $ENV:VAR_NAME.
- Não re-preencha um campo que você já preencheu, a menos que a página tenha limpado o valor — cada ação sua vira um passo do script gravado, e passos duplicados são ruído que fragiliza o replay.
- Seja econômico: não explore além do cenário.`;

  const result = query({
    prompt: `Verifique este cenário de QA:\n\n## ${scenario.name}\n\n${scenario.scenario}${scenario.notes ? `\n\nNotas: ${scenario.notes}` : ""}`,
    options: {
      model: config.model,
      maxTurns: config.maxTurns,
      systemPrompt,
      mcpServers: { browser: browserServer },
      allowedTools: ["mcp__browser__*"],
      tools: [],
      settingSources: [],
      permissionMode: "bypassPermissions",
    },
  });

  for await (const message of result) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) transcript.push(block.text.trim());
      }
    }
    if (message.type === "result") break;
  }

  if (!verdict) {
    verdict = {
      verdict: "blocked",
      reason: "Agente encerrou sem registrar veredito (scout_verdict não foi chamado).",
    };
  }

  return { ...verdict, steps, transcript };
}
