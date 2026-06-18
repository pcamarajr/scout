import { z } from "zod";
import type { ScoutConfig } from "../config.js";
import type { Step, Verdict } from "../types.js";
import { BrowserSession, resolveEnvValue } from "./browser.js";
import { relativizeUrl } from "./engines/types.js";

/** Normalized result every engine adapter maps into its own SDK shape. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

/**
 * Engine-neutral tool definition. Both the Agent SDK and the AI SDK engines
 * consume this single source of truth — neither SDK type leaks in here.
 */
export interface ScoutTool {
  name: string;
  description: string;
  /**
   * Zod object input schema. The AI SDK consumes it directly as `inputSchema`;
   * the Agent SDK adapter passes `schema.shape` (its `tool()` wants a raw shape).
   */
  schema: z.ZodObject;
  handler: (args: unknown) => Promise<ToolResult>;
}

/**
 * Context the tool factory closes over. `record` collects deterministic Steps,
 * `setVerdict` is the verdict sink (scout_verdict writes here as a side effect,
 * exactly like the original closure-over-`verdict` design), and `session`/
 * `config` drive the actual browser actions.
 */
export interface ScoutToolContext {
  session: BrowserSession;
  config: ScoutConfig;
  record: (step: Step) => void;
  setVerdict: (verdict: { verdict: Verdict; reason: string }) => void;
}

const ok = (text: string): ToolResult => ({ text });
const fail = (error: unknown): ToolResult => ({
  text: `ERRO: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * Builds the 9 browser tools + scout_verdict as engine-neutral definitions.
 * The Portuguese descriptions/messages are intentionally verbatim from the
 * original ai-runner — they are part of the verifier's behavior and are tracked
 * for a separate English-sweep chore, NOT to be translated here.
 */
export function createScoutTools(ctx: ScoutToolContext): ScoutTool[] {
  const { session, config, record, setVerdict } = ctx;

  const afterAction = async (): Promise<string> => {
    const snap = await session.snapshot();
    return session.formatSnapshot(snap);
  };

  const define = <S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<S>) => Promise<ToolResult>
  ): ScoutTool => ({
    name,
    description,
    schema,
    handler: (args) => handler(schema.parse(args)),
  });

  return [
    define(
      "browser_navigate",
      "Navega para uma URL (absoluta ou relativa ao baseUrl do app). Para tokens/segredos na URL use placeholder $ENV:VAR_NAME — resolvido em runtime, nunca passa por você.",
      z.object({ url: z.string().describe("Ex: /login, /renovar?token=$ENV:TOKEN ou https://...") }),
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
    define(
      "browser_snapshot",
      "Retorna o estado atual da página: URL, título, elementos interativos numerados [ref] e texto visível. Use sempre que precisar decidir a próxima ação.",
      z.object({}),
      async () => {
        try {
          return ok(await afterAction());
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_click",
      "Clica no elemento identificado pelo [ref] do último snapshot.",
      z.object({ ref: z.number().int().describe("Ref numérico do snapshot") }),
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
    define(
      "browser_fill",
      "Preenche um campo. Para credenciais/segredos use placeholder $ENV:VAR_NAME — o valor real vem do ambiente e nunca passa por você.",
      z.object({
        ref: z.number().int(),
        value: z.string().describe("Texto literal ou $ENV:VAR_NAME"),
      }),
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
    define(
      "browser_select",
      "Seleciona uma opção em um <select> pelo value ou label.",
      z.object({ ref: z.number().int(), value: z.string() }),
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
    define(
      "browser_press",
      "Pressiona uma tecla (Enter, Escape, Tab, ArrowDown...).",
      z.object({ key: z.string() }),
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
    define(
      "browser_wait_for",
      "Espera texto aparecer na página OU a URL conter um trecho. Use após ações que disparam carregamento.",
      z.object({
        text: z.string().optional().describe("Texto que deve ficar visível"),
        urlContains: z.string().optional().describe("Trecho esperado na URL"),
      }),
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
    define(
      "browser_assert",
      "Registra uma verificação do comportamento esperado. Use para CADA expectativa do cenário — essas asserções viram o teste determinístico.",
      z.object({
        visibleText: z.string().optional().describe("Texto que DEVE estar visível"),
        notVisibleText: z.string().optional().describe("Texto que NÃO deve estar visível"),
        urlContains: z.string().optional().describe("Trecho que a URL deve conter"),
      }),
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
    define(
      "browser_screenshot",
      "Captura screenshot como evidência. Use em momentos-chave (estado final, paywall, erro encontrado).",
      z.object({ label: z.string().describe("Rótulo curto, ex: 'paywall-exibido'") }),
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
    define(
      "scout_verdict",
      "OBRIGATÓRIO ao final: registra o veredito da verificação. Após chamar, encerre.",
      z.object({
        verdict: z.enum(["verified", "failed", "partial", "blocked"]),
        reason: z.string().describe("Justificativa objetiva, citando o que foi observado"),
      }),
      async (args) => {
        setVerdict(args);
        return ok("Veredito registrado. Encerre agora.");
      }
    ),
  ];
}
