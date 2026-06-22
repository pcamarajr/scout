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
 * Builds the browser tools + scout_verdict as engine-neutral definitions.
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
          const before = session.tabCount();
          const target = await session.click(ref);
          record({ kind: "click", target });
          const opened =
            session.tabCount() > before
              ? "\n\n⚠️ Um novo tab/aba foi aberto por esse clique. Use browser_switch_tab para interagir com ele antes de continuar."
              : "";
          return ok(`Cliquei em ${target.description}.${opened}\n\n${await afterAction()}`);
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_switch_tab",
      "Troca o controle para outro tab/aba do navegador (ex: após um clique que abre um popup). Sem urlGlob, vai para o tab mais recém-aberto. Com urlGlob, vai para o tab cuja URL casa o padrão (* dentro de um segmento, ** entre segmentos). Espera o tab carregar. Vira passo determinístico.",
      z.object({
        urlGlob: z
          .string()
          .optional()
          .describe("Glob da URL do tab alvo, ex: **/booking**. Omitido = tab mais recente."),
      }),
      async ({ urlGlob }) => {
        try {
          await session.switchTab(urlGlob);
          record({ kind: "switchTab", ...(urlGlob ? { urlGlob } : {}) });
          return ok(`Troquei para o tab: ${session.page.url()}.\n\n${await afterAction()}`);
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
      "browser_inspect_logs",
      "Mostra o que o tab ATIVO registrou: requests de rede (método, status, URL) e mensagens de console — errors/warnings E outras (log/debug/info). Use ANTES de browser_assert_network / browser_assert_no_console_errors / browser_assert_console_message para ver o que de fato aconteceu e escrever uma asserção tolerante (case por padrão de URL + status ou por um trecho ESTÁVEL da mensagem, nunca por valores voláteis).",
      z.object({}),
      async () => {
        try {
          return ok(session.formatLogs());
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_assert_network",
      'Verifica que uma chamada de rede esperada aconteceu. Case o request por método + padrão de URL (urlGlob com * e **) e, opcionalmente, status. Para inspecionar o corpo da resposta use responseIncludes com trechos ESTÁVEIS (nomes de campos como "orderId"), nunca valores voláteis (ids, timestamps). Vira teste determinístico.',
      z.object({
        urlGlob: z.string().describe("Padrão da URL, ex: **/api/checkout/**"),
        method: z.string().optional().describe("GET, POST, ... (omitido = qualquer método)"),
        status: z
          .union([z.number().int(), z.enum(["2xx", "3xx", "4xx", "5xx"])])
          .optional()
          .describe("Status exato (200) ou classe (2xx)"),
        responseIncludes: z
          .array(z.string())
          .optional()
          .describe("Trechos que DEVEM aparecer no corpo da resposta"),
      }),
      async ({ urlGlob, method, status, responseIncludes }) => {
        try {
          await session.assertNetwork({ urlGlob, method, status, responseIncludes });
          record({ kind: "assertNetwork", urlGlob, method, status, responseIncludes });
          return ok(
            `Asserção de rede passou: ${method ?? "ANY"} ${urlGlob}${status ? ` (status ${status})` : ""}.`
          );
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_assert_no_console_errors",
      "Verifica que NÃO houve erros no console do browser (console.error + exceções não capturadas) durante o fluxo. Use ignore para tolerar erros conhecidos/esperados (casa por substring). Vira teste determinístico.",
      z.object({
        ignore: z
          .array(z.string())
          .optional()
          .describe("Substrings de erros conhecidos a ignorar"),
      }),
      async ({ ignore }) => {
        try {
          await session.assertNoConsoleErrors(ignore);
          record({ kind: "assertNoConsoleErrors", ignore });
          return ok("Nenhum erro no console.");
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_assert_console_message",
      'Verifica que o console do tab ATIVO registrou uma mensagem contendo TODOS os trechos informados, casados numa MESMA mensagem (não espalhados). Rode browser_inspect_logs antes para ver o texto real e escolher trechos ESTÁVEIS (ex: o prefixo "DEBUG:[FEATURE/...]"), nunca valores voláteis. Opcionalmente restrinja por tipo. Vira teste determinístico.',
      z.object({
        includes: z
          .array(z.string().min(1))
          .min(1)
          .describe("Trechos NÃO-VAZIOS que devem TODOS aparecer numa mesma mensagem"),
        type: z
          .string()
          .optional()
          .describe("Tipo do console: log, debug, info, warning, error (omitido = qualquer)"),
      }),
      async ({ includes, type }) => {
        try {
          await session.assertConsoleMessage(includes, type);
          record({ kind: "assertConsoleMessage", includes, ...(type ? { type } : {}) });
          return ok(
            `Asserção de console passou: mensagem contendo ${includes.join(" + ")}${type ? ` (tipo ${type})` : ""}.`
          );
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
