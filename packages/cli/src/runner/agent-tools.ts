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
  text: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * Builds the browser tools + scout_verdict as engine-neutral definitions. Each
 * tool wraps a BrowserSession action, records the deterministic Step it produced
 * (via `record`), and returns an updated page snapshot so the agent can decide
 * its next move; scout_verdict writes the run's verdict through `setVerdict`.
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
      "Navigates to a URL (absolute or relative to the app's baseUrl). For tokens/secrets in the URL use the placeholder $ENV:VAR_NAME — resolved at runtime, never passes through you.",
      z.object({ url: z.string().describe("E.g. /login, /renew?token=$ENV:TOKEN or https://...") }),
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
      "Returns the current page state: URL, title, numbered interactive elements [ref] and visible text. Use it whenever you need to decide the next action.",
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
      "Clicks the element identified by the [ref] from the last snapshot.",
      z.object({ ref: z.number().int().describe("Numeric ref from the snapshot") }),
      async ({ ref }) => {
        try {
          const before = session.tabCount();
          const target = await session.click(ref);
          record({ kind: "click", target });
          const opened =
            session.tabCount() > before
              ? "\n\n⚠️ A new tab was opened by this click. Use browser_switch_tab to interact with it before continuing."
              : "";
          return ok(`Clicked ${target.description}.${opened}\n\n${await afterAction()}`);
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_switch_tab",
      "Switches control to another browser tab (e.g. after a click that opens a popup). Without urlGlob, goes to the most recently opened tab. With urlGlob, goes to the tab whose URL matches the pattern (* within a segment, ** across segments). Waits for the tab to load. Becomes a deterministic step.",
      z.object({
        urlGlob: z
          .string()
          .optional()
          .describe("Glob of the target tab's URL, e.g. **/booking**. Omitted = most recent tab."),
      }),
      async ({ urlGlob }) => {
        try {
          await session.switchTab(urlGlob);
          record({ kind: "switchTab", ...(urlGlob ? { urlGlob } : {}) });
          return ok(`Switched to tab: ${session.page.url()}.\n\n${await afterAction()}`);
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_fill",
      "Fills a field. For credentials/secrets use the placeholder $ENV:VAR_NAME — the real value comes from the environment and never passes through you.",
      z.object({
        ref: z.number().int(),
        value: z.string().describe("Literal text or $ENV:VAR_NAME"),
      }),
      async ({ ref, value }) => {
        try {
          const target = await session.fill(ref, resolveEnvValue(value));
          record({ kind: "fill", target, value });
          return ok(`Filled ${target.description}.`);
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_select",
      "Selects an option in a <select> by value or label.",
      z.object({ ref: z.number().int(), value: z.string() }),
      async ({ ref, value }) => {
        try {
          const target = await session.select(ref, resolveEnvValue(value));
          record({ kind: "select", target, value });
          return ok(`Selected "${value}" in ${target.description}.\n\n${await afterAction()}`);
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_press",
      "Presses a key (Enter, Escape, Tab, ArrowDown...).",
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
      "browser_wheel",
      "Dispatches a scroll gesture (mouse wheel) at position (x, y) — omitted = viewport center. Positive deltaY scrolls down. Use on scroll/gesture-driven UIs (vertical feeds, carousels, swipe pagination) that don't respond to the keyboard.",
      z.object({
        deltaX: z.number().describe("Horizontal delta in px (positive = right)"),
        deltaY: z.number().describe("Vertical delta in px (positive = down)"),
        x: z.number().int().optional().describe("Gesture X position (omitted = center)"),
        y: z.number().int().optional().describe("Gesture Y position (omitted = center)"),
      }),
      async ({ deltaX, deltaY, x, y }) => {
        try {
          await session.wheel(deltaX, deltaY, x, y);
          record({
            kind: "wheel",
            deltaX,
            deltaY,
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
          });
          return ok(await afterAction());
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_drag",
      "Drags the mouse from (fromX, fromY) to (toX, toY) — down, movement in intermediate steps, up. Emulates swipe/drag (advancing an item in a feed, closing a bottom-sheet, slider). Coordinates in px relative to the viewport.",
      z.object({
        fromX: z.number().int(),
        fromY: z.number().int(),
        toX: z.number().int(),
        toY: z.number().int(),
      }),
      async ({ fromX, fromY, toX, toY }) => {
        try {
          await session.drag(fromX, fromY, toX, toY);
          record({ kind: "drag", fromX, fromY, toX, toY });
          return ok(await afterAction());
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_wait_for",
      "Waits for text to appear on the page OR the URL to contain a substring. Use after actions that trigger loading.",
      z.object({
        text: z.string().optional().describe("Text that should become visible"),
        urlContains: z.string().optional().describe("Substring expected in the URL"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms for this wait (default 10000)"),
      }),
      async ({ text, urlContains, timeoutMs }) => {
        try {
          if (text) {
            await session.waitForText(text, timeoutMs);
            record({ kind: "waitForText", text, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
          }
          if (urlContains) {
            await session.waitForUrl(urlContains, timeoutMs);
            record({
              kind: "waitForUrl",
              pattern: urlContains,
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            });
          }
          return ok(await afterAction());
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_assert",
      "Records a check of the expected behavior. Use it for EVERY scenario expectation — these assertions become the deterministic test.",
      z.object({
        visibleText: z.string().optional().describe("Text that MUST be visible"),
        notVisibleText: z.string().optional().describe("Text that must NOT be visible"),
        urlContains: z.string().optional().describe("Substring the URL must contain"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms for these assertions (default 10000)"),
        oneShot: z
          .boolean()
          .optional()
          .describe(
            "For visibleText only: waits for the page to settle (network idle, capped at 2s) and checks ONCE instead of polling the whole timeout. Use only when the text should already be present on the loaded page — content that arrives late (streaming, slow hydration) needs the default poll."
          ),
      }),
      async ({ visibleText, notVisibleText, urlContains, timeoutMs, oneShot }) => {
        try {
          if (visibleText) {
            await session.assertVisible(visibleText, { timeout: timeoutMs, oneShot });
            record({
              kind: "assertVisible",
              text: visibleText,
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
              ...(oneShot ? { oneShot: true } : {}),
            });
          }
          if (notVisibleText) {
            await session.assertNotVisible(notVisibleText, timeoutMs);
            record({
              kind: "assertNotVisible",
              text: notVisibleText,
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            });
          }
          if (urlContains) {
            await session.assertUrl(urlContains, timeoutMs);
            record({
              kind: "assertUrl",
              pattern: urlContains,
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            });
          }
          return ok("Assertion passed.");
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_inspect_logs",
      "Shows what the ACTIVE tab recorded: network requests (method, status, URL) and console messages — errors/warnings AND others (log/debug/info). Use it BEFORE browser_assert_network / browser_assert_no_console_errors / browser_assert_console_message to see what actually happened and write a tolerant assertion (match by URL pattern + status or by a STABLE part of the message, never by volatile values).",
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
      'Verifies that an expected network call happened. Match the request by method + URL pattern (urlGlob with * and **) and, optionally, status. To inspect the response body use responseIncludes with STABLE substrings (field names like "orderId"), never volatile values (ids, timestamps). Becomes a deterministic test.',
      z.object({
        urlGlob: z.string().describe("URL pattern, e.g. **/api/checkout/**"),
        method: z.string().optional().describe("GET, POST, ... (omitted = any method)"),
        status: z
          .union([z.number().int(), z.enum(["2xx", "3xx", "4xx", "5xx"])])
          .optional()
          .describe("Exact status (200) or class (2xx)"),
        responseIncludes: z
          .array(z.string())
          .optional()
          .describe("Substrings that MUST appear in the response body"),
      }),
      async ({ urlGlob, method, status, responseIncludes }) => {
        try {
          await session.assertNetwork({ urlGlob, method, status, responseIncludes });
          record({ kind: "assertNetwork", urlGlob, method, status, responseIncludes });
          return ok(
            `Network assertion passed: ${method ?? "ANY"} ${urlGlob}${status ? ` (status ${status})` : ""}.`
          );
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_assert_no_console_errors",
      "Verifies that there were NO errors in the browser console (console.error + uncaught exceptions) during the flow. Use ignore to tolerate known/expected errors (matched by substring). Becomes a deterministic test.",
      z.object({
        ignore: z
          .array(z.string())
          .optional()
          .describe("Substrings of known errors to ignore"),
      }),
      async ({ ignore }) => {
        try {
          await session.assertNoConsoleErrors(ignore);
          record({ kind: "assertNoConsoleErrors", ignore });
          return ok("No console errors.");
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_assert_console_message",
      'Verifies that the ACTIVE tab\'s console logged a message containing ALL of the given substrings, matched within a SINGLE message (not spread across messages). Run browser_inspect_logs first to see the real text and pick STABLE substrings (e.g. the prefix "DEBUG:[FEATURE/...]"), never volatile values. Optionally constrain by type. Becomes a deterministic test.',
      z.object({
        includes: z
          .array(z.string().min(1))
          .min(1)
          .describe("NON-EMPTY substrings that must ALL appear within a single message"),
        type: z
          .string()
          .optional()
          .describe("Console type: log, debug, info, warning, error (omitted = any)"),
      }),
      async ({ includes, type }) => {
        try {
          await session.assertConsoleMessage(includes, type);
          record({ kind: "assertConsoleMessage", includes, ...(type ? { type } : {}) });
          return ok(
            `Console assertion passed: message containing ${includes.join(" + ")}${type ? ` (type ${type})` : ""}.`
          );
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "browser_screenshot",
      "Captures a screenshot as evidence. Use it at key moments (final state, paywall, error encountered).",
      z.object({ label: z.string().describe("Short label, e.g. 'paywall-shown'") }),
      async ({ label }) => {
        try {
          await session.screenshot(label);
          record({ kind: "screenshot", label });
          return ok(`Screenshot "${label}" saved.`);
        } catch (e) {
          return fail(e);
        }
      }
    ),
    define(
      "scout_verdict",
      "MANDATORY at the end: records the verification verdict. After calling it, stop.",
      z.object({
        verdict: z.enum(["verified", "failed", "partial", "blocked"]),
        reason: z.string().describe("Objective justification, citing what was observed"),
      }),
      async (args) => {
        setVerdict(args);
        return ok("Verdict recorded. Stop now.");
      }
    ),
  ];
}
