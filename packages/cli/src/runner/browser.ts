import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { NetworkMatcher, PermissionPolicy, ScenarioCookie, Step, Target } from "../types.js";
import {
  findConsoleErrors,
  globToRegex,
  matchNetwork,
  type CapturedRequest,
  type ConsoleMessage,
} from "./network-match.js";

export interface ElementInfo {
  ref: number;
  role: string;
  name: string;
  css: string;
  tag: string;
  value?: string;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementInfo[];
}

export interface LaunchOptions {
  baseUrl: string;
  headless: boolean;
  storageState?: string;
  locale?: string;
  runDir: string;
  /** Record a WebM of the context (used only by the preview-video replay) */
  recordVideo?: boolean;
  /** Playwright slowMo (ms/action) — paces the preview replay for human viewing */
  slowMoMs?: number;
  /** Browser permission policy resolved from the scenario spec (grant/deny/geo). */
  permissions?: PermissionPolicy;
  /**
   * Cookies to seed into the context before the first navigation (profile +
   * scenario, already merged). `value` may carry a `$ENV:VAR` placeholder,
   * resolved here at launch — never persisted resolved.
   */
  cookies?: ScenarioCookie[];
  /**
   * Extra HTTP headers sent on every request in the context. Set from
   * `scout.config.json` `headers` or `SCOUT_EXTRA_HEADERS`. The canonical use is
   * reaching a protected deploy — e.g. Vercel's `x-vercel-protection-bypass`.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Builds an init-script that denies the permissions that would otherwise pop a
 * native prompt (geolocation, notifications, camera, microphone), stubbing the
 * Web APIs so the prompt never reaches the browser. Runs before any page
 * script, in every page of the context (including popups). `deny` only matters
 * in headed runs — headless already denies silently.
 */
export function denyPermissionsStub(deny: string[]): string {
  return `(() => {
    const denied = ${JSON.stringify(deny)};
    if (denied.includes("geolocation") && navigator.geolocation) {
      const fail = (_s, e) => { if (e) e({ code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); };
      navigator.geolocation.getCurrentPosition = fail;
      navigator.geolocation.watchPosition = (s, e) => { fail(s, e); return 0; };
    }
    if (denied.includes("notifications") && "Notification" in window) {
      try { Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "denied" }); } catch (_e) {}
      window.Notification.requestPermission = () => Promise.resolve("denied");
    }
    if ((denied.includes("camera") || denied.includes("microphone")) && navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    }
  })();`;
}

const VIDEO_SIZE = { width: 390, height: 844 } as const;

const STEP_TIMEOUT = 10_000;

/** Cap the ring buffers so a long-running session can't grow them unbounded. */
const NETWORK_LOG_CAP = 300;
const CONSOLE_LOG_CAP = 500;

/**
 * Thin Playwright wrapper shared by the AI runner and the replay runner.
 * Owns ref→element resolution, tracing and screenshots.
 */
export class BrowserSession {
  private screenshotCount = 0;
  readonly screenshots: string[] = [];
  /**
   * Per-page ring-buffered observers (console + network), keyed by Page. A
   * popup's logs/requests stay scoped to its own tab; asserts and formatLogs
   * read the ACTIVE tab's buffer. Listeners are attached when each page is born
   * (incl. popups), so a new tab's early logs are not missed.
   */
  private pageBuffers = new Map<Page, { console: ConsoleMessage[]; network: CapturedRequest[] }>();
  /** The tab the agent/replay currently acts on; changed by switchTab. */
  private activePage: Page;
  /** The first page — it owns the recorded video for the whole context. */
  private readonly firstPage: Page;

  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    page: Page,
    private opts: LaunchOptions,
    /** Date.now() at video start (context creation); undefined when not recording */
    readonly videoEpoch: number | undefined,
    private refs = new Map<number, ElementInfo>()
  ) {
    this.activePage = page;
    this.firstPage = page;
  }

  /** The tab currently under control. Switching tabs reassigns it. */
  get page(): Page {
    return this.activePage;
  }

  static async launch(opts: LaunchOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: opts.headless, slowMo: opts.slowMoMs });
    const perm = opts.permissions;
    const context = await browser.newContext({
      locale: opts.locale ?? "pt-BR",
      viewport: { ...VIDEO_SIZE }, // mobile-first; vertical video product
      storageState: opts.storageState,
      ...(opts.extraHeaders ? { extraHTTPHeaders: opts.extraHeaders } : {}),
      ...(perm?.grant?.length ? { permissions: perm.grant } : {}),
      ...(perm?.geolocation ? { geolocation: perm.geolocation } : {}),
      ...(opts.recordVideo ? { recordVideo: { dir: opts.runDir, size: { ...VIDEO_SIZE } } } : {}),
    });
    // Deny stub must run before any page script and in every page (incl. popups).
    if (perm?.deny?.length) await context.addInitScript(denyPermissionsStub(perm.deny));
    // Seed declared cookies before any navigation, so the server reads them on
    // the very first request (e.g. a server-side experiment variant). After
    // storageState load → declared cookies win over the auth session by name.
    if (opts.cookies?.length) {
      await context.addCookies(opts.cookies.map((c) => toPlaywrightCookie(c, opts.baseUrl)));
    }
    const videoEpoch = opts.recordVideo ? Date.now() : undefined;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    const session = new BrowserSession(browser, context, page, opts, videoEpoch);
    session.trackPage(page); // first page: registered before context.on("page")
    context.on("page", (p) => session.trackPage(p)); // popups/new tabs
    return session;
  }

  /**
   * Passive observers for console + network. We only LISTEN (never `route()`),
   * so the real app traffic is untouched — these feed the deterministic
   * assertNetwork / assertNoConsoleErrors checks.
   */
  /**
   * Starts passive console + network observers on a page and registers its
   * ring-buffered store. Called for the first page and for every popup/new tab
   * the context opens, so a tab's logs are captured from birth — before any
   * switchTab. Idempotent. We only LISTEN (never route()), so app traffic is
   * untouched.
   */
  private trackPage(page: Page): void {
    if (this.pageBuffers.has(page)) return;
    const buf = { console: [] as ConsoleMessage[], network: [] as CapturedRequest[] };
    this.pageBuffers.set(page, buf);
    page.setDefaultTimeout(STEP_TIMEOUT);
    page.on("close", () => this.pageBuffers.delete(page)); // release a closed popup's buffer
    const pushConsole = (msg: ConsoleMessage): void => {
      buf.console.push(msg);
      if (buf.console.length > CONSOLE_LOG_CAP) buf.console.shift();
    };
    page.on("console", (msg) => pushConsole({ type: msg.type(), text: msg.text() }));
    page.on("pageerror", (err) => pushConsole({ type: "error", text: `${err.name}: ${err.message}` }));
    page.on("response", (res) => {
      const req = res.request();
      let body: Promise<string> | undefined;
      buf.network.push({
        method: req.method(),
        url: res.url(),
        status: res.status(),
        getBody: () => (body ??= res.text().catch(() => "")),
      });
      if (buf.network.length > NETWORK_LOG_CAP) buf.network.shift();
    });
  }

  /** Console + network buffers for a page (the active tab by default). */
  private buffers(page: Page = this.activePage): {
    console: ConsoleMessage[];
    network: CapturedRequest[];
  } {
    let buf = this.pageBuffers.get(page);
    if (!buf) {
      buf = { console: [], network: [] };
      this.pageBuffers.set(page, buf);
    }
    return buf;
  }

  /** Number of open tabs in the context — lets a click hint that one opened. */
  tabCount(): number {
    return this.context.pages().length;
  }

  /**
   * Switches the active tab. With no glob, waits for and moves to the newest
   * other tab (the one a click just opened). With a glob, waits for a tab whose
   * URL matches it. Then waits for the tab to finish loading so the next
   * snapshot/assert doesn't race the popup's about:blank → real-URL navigation.
   */
  async switchTab(urlGlob?: string): Promise<void> {
    const target = urlGlob ? await this.findTabByUrl(urlGlob) : await this.newestOtherTab();
    this.activePage = target;
    await target.waitForLoadState("load").catch(() => {});
    await target.bringToFront().catch(() => {});
  }

  /** The most recently opened tab other than the active one, waiting if none yet. */
  private async newestOtherTab(): Promise<Page> {
    const others = this.context.pages().filter((p) => p !== this.activePage);
    if (others.length) return others[others.length - 1];
    return this.context.waitForEvent("page", { timeout: STEP_TIMEOUT });
  }

  /**
   * Resolves a tab whose URL matches the glob, tolerating the about:blank →
   * real-URL transition of a freshly opened popup: it watches both already-open
   * tabs and tabs opened later, re-checking on every navigation until one
   * matches or the step timeout elapses.
   *
   * When several tabs match (the glob is unanchored "contains", so a broad glob
   * like `**\/it-it/**` can match both the opener and the popup), the MOST
   * RECENTLY opened match wins — that is the tab a click just produced, not the
   * opener at index 0.
   */
  private async findTabByUrl(urlGlob: string): Promise<Page> {
    const re = globToRegex(urlGlob);
    const found = (): Page | undefined => {
      const matches = this.context.pages().filter((p) => re.test(p.url()));
      return matches[matches.length - 1];
    };
    const existing = found();
    if (existing) return existing;
    return await new Promise<Page>((resolve, reject) => {
      const check = (): void => {
        const m = found();
        if (m) {
          cleanup();
          resolve(m);
        }
      };
      const onPage = (p: Page): void => {
        p.on("framenavigated", check);
        check();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.context.off("page", onPage);
        for (const p of this.context.pages()) p.off("framenavigated", check);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Nenhum tab com URL casando "${urlGlob}" em ${STEP_TIMEOUT}ms.`));
      }, STEP_TIMEOUT);
      this.context.on("page", onPage);
      for (const p of this.context.pages()) p.on("framenavigated", check);
    });
  }

  resolveUrl(url: string): string {
    return new URL(url, this.opts.baseUrl).toString();
  }

  async navigate(url: string): Promise<void> {
    // Resolve $ENV:VAR before resolveUrl so tokens/credentials in the query
    // string (e.g. /renew?token=$ENV:TOKEN) work just like in browser_fill.
    await this.page.goto(this.resolveUrl(resolveEnvValue(url)), { waitUntil: "domcontentloaded" });
  }

  /**
   * Builds a numbered map of visible interactive elements (role + accessible
   * name + CSS path) plus a text excerpt. Refs are valid until the next snapshot.
   */
  async snapshot(): Promise<PageSnapshot> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    const raw = (await this.page.evaluate(snapshotScript)) as {
      elements: ElementInfo[];
      text: string;
    };
    this.refs.clear();
    for (const el of raw.elements) this.refs.set(el.ref, el);
    return { url: this.page.url(), title: await this.page.title(), ...raw };
  }

  formatSnapshot(snap: PageSnapshot): string {
    const lines = snap.elements.map((e) => {
      const extra = [e.value ? `value="${e.value}"` : "", e.href ? `href="${e.href}"` : ""]
        .filter(Boolean)
        .join(" ");
      return `[${e.ref}] ${e.role} "${e.name}"${extra ? " " + extra : ""}`;
    });
    return [
      `URL: ${snap.url}`,
      `Title: ${snap.title}`,
      ``,
      `Interactive elements:`,
      ...lines,
      ``,
      `Visible text (excerpt):`,
      snap.text,
    ].join("\n");
  }

  /**
   * Resolves a snapshot ref to a locator AND the durable Target recorded for
   * replay: role+name when unique on the page, CSS path otherwise.
   */
  private async resolveRef(ref: number): Promise<{ locator: Locator; target: Target }> {
    const info = this.refs.get(ref);
    if (!info) {
      throw new Error(`Ref [${ref}] desconhecido — tire um novo browser_snapshot, a página mudou.`);
    }
    const description = `${info.role} "${info.name}"`;
    if (info.role && info.name) {
      const byRole = this.page.getByRole(info.role as Parameters<Page["getByRole"]>[0], {
        name: info.name,
        exact: true,
      });
      if ((await byRole.count()) === 1) {
        return { locator: byRole, target: { role: info.role, name: info.name, description } };
      }
    }
    return { locator: this.page.locator(info.css), target: { css: info.css, description } };
  }

  async click(ref: number): Promise<Target> {
    const { locator, target } = await this.resolveRef(ref);
    await locator.click();
    return target;
  }

  async fill(ref: number, value: string): Promise<Target> {
    const { locator, target } = await this.resolveRef(ref);
    await locator.fill(value);
    return target;
  }

  async select(ref: number, value: string): Promise<Target> {
    const { locator, target } = await this.resolveRef(ref);
    await locator.selectOption(value);
    return target;
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async waitForText(text: string): Promise<void> {
    await this.page.getByText(text).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  }

  async waitForUrl(pattern: string): Promise<void> {
    await this.page.waitForURL((u) => u.toString().includes(pattern), { timeout: STEP_TIMEOUT });
  }

  async assertVisible(text: string): Promise<void> {
    await this.page.getByText(text).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  }

  async assertNotVisible(text: string): Promise<void> {
    // give the page a beat to render, then require absence
    await this.page.waitForTimeout(1000);
    const visible = await this.page
      .getByText(text)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) throw new Error(`Texto "${text}" está visível, mas não deveria estar.`);
  }

  async assertUrl(pattern: string): Promise<void> {
    const url = this.page.url();
    if (!url.includes(pattern)) {
      throw new Error(`URL atual "${url}" não contém "${pattern}".`);
    }
  }

  /** Asserts an expected network call was observed. Throws with a reason on miss. */
  async assertNetwork(matcher: NetworkMatcher): Promise<void> {
    const result = await matchNetwork(this.buffers().network, matcher);
    if (!result.ok) throw new Error(result.reason ?? "Asserção de rede falhou.");
  }

  /** Asserts no console errors (console.error + uncaught) except ignored substrings. */
  async assertNoConsoleErrors(ignore: string[] = []): Promise<void> {
    const errors = findConsoleErrors(this.buffers().console, ignore);
    if (errors.length) {
      const sample = errors.slice(0, 5).map((e) => e.text).join(" | ");
      throw new Error(`${errors.length} erro(s) no console do browser: ${sample}`);
    }
  }

  /**
   * Asserts the active tab logged at least one console message containing ALL
   * of `includes` within a SINGLE message (not spread across messages),
   * optionally constrained to a console `type` (log, debug, error, ...).
   * Tolerant by design: a specific substring (e.g. a "DEBUG:[FEATURE/x]"
   * prefix) won't match unrelated console noise.
   */
  async assertConsoleMessage(includes: string[], type?: string): Promise<void> {
    // An empty substring matches every message, so any "" would make the
    // assertion always pass — false confidence on replay. Reject it here too,
    // mirroring the tool schema, so a hand-edited or legacy script fails closed.
    if (!includes.length || includes.some((s) => s.length === 0)) {
      throw new Error("assertConsoleMessage requer trechos não-vazios.");
    }
    const hit = this.buffers().console.find(
      (m) => (!type || m.type === type) && includes.every((s) => m.text.includes(s))
    );
    if (!hit) {
      const want = includes.map((s) => `"${s}"`).join(" + ");
      throw new Error(
        `Nenhuma mensagem de console${type ? ` do tipo "${type}"` : ""} continha ${want}.`
      );
    }
  }

  /** Compact dump of recent network + console activity for the agent to inspect. */
  formatLogs(): string {
    const { console: consoleMessages, network: networkRequests } = this.buffers();
    const net = networkRequests.slice(-30).map((e) => `${e.method} ${e.status} ${e.url}`);
    const isErrLike = (t: string): boolean => t === "error" || t === "warning" || t === "warn";
    const errs = consoleMessages
      .filter((m) => isErrLike(m.type))
      .slice(-30)
      .map((m) => `[${m.type}] ${m.text}`);
    // Other messages (log/debug/info) are surfaced too so the agent can read a
    // DEBUG line before asserting on it with browser_assert_console_message.
    const other = consoleMessages
      .filter((m) => !isErrLike(m.type))
      .slice(-30)
      .map((m) => `[${m.type}] ${m.text}`);
    return [
      `Network (${networkRequests.length} requests total, últimos ${net.length}):`,
      ...(net.length ? net.map((l) => `  ${l}`) : ["  (nenhum)"]),
      ``,
      `Console errors/warnings (${errs.length}):`,
      ...(errs.length ? errs.map((l) => `  ${l}`) : ["  (nenhum)"]),
      ``,
      `Outras mensagens de console (${other.length}, p/ assert_console_message):`,
      ...(other.length ? other.map((l) => `  ${l}`) : ["  (nenhum)"]),
    ].join("\n");
  }

  async screenshot(label: string): Promise<string> {
    this.screenshotCount += 1;
    const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const file = path.join(this.opts.runDir, `${String(this.screenshotCount).padStart(2, "0")}-${safe}.png`);
    await this.page.screenshot({ path: file, fullPage: false });
    this.screenshots.push(file);
    return file;
  }

  /** Replays one recorded step (used by the deterministic runner). */
  async executeStep(step: Step): Promise<void> {
    switch (step.kind) {
      case "navigate":
        return this.navigate(step.url);
      case "click":
        return void (await this.targetLocator(step.target).click());
      case "fill":
        return void (await this.targetLocator(step.target).fill(resolveEnvValue(step.value)));
      case "select":
        return void (await this.targetLocator(step.target).selectOption(resolveEnvValue(step.value)));
      case "press":
        return this.press(step.key);
      case "waitForText":
        return this.waitForText(step.text);
      case "waitForUrl":
        return this.waitForUrl(step.pattern);
      case "assertVisible":
        return this.assertVisible(step.text);
      case "assertNotVisible":
        return this.assertNotVisible(step.text);
      case "assertUrl":
        return this.assertUrl(step.pattern);
      case "assertNetwork":
        return this.assertNetwork(step);
      case "assertNoConsoleErrors":
        return this.assertNoConsoleErrors(step.ignore);
      case "assertConsoleMessage":
        return this.assertConsoleMessage(step.includes, step.type);
      case "switchTab":
        return this.switchTab(step.urlGlob);
      case "screenshot":
        return void (await this.screenshot(step.label));
    }
  }

  private targetLocator(target: Target): Locator {
    if (target.role && target.name) {
      return this.page
        .getByRole(target.role as Parameters<Page["getByRole"]>[0], {
          name: target.name,
          exact: true,
        })
        .first();
    }
    if (target.css) return this.page.locator(target.css);
    throw new Error(`Target sem estratégia de localização: ${target.description}`);
  }

  async close(): Promise<{ trace?: string; video?: string }> {
    let trace: string | undefined;
    try {
      trace = path.join(this.opts.runDir, "trace.zip");
      await this.context.tracing.stop({ path: trace });
    } catch {
      trace = undefined;
    }
    // The Video handle must be captured before close(); the file is only
    // finalized once the context is closed (hence close() is awaited). The
    // first page owns the context recording, even after switching tabs.
    const video = this.firstPage.video();
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
    let videoPath: string | undefined;
    if (video) {
      try {
        videoPath = await video.path();
      } catch {
        videoPath = undefined;
      }
    }
    return { trace, video: videoPath };
  }
}

/** The cookie shape Playwright's `context.addCookies()` accepts. */
type AddCookieParam = Parameters<BrowserContext["addCookies"]>[0][number];

/**
 * Maps a declared ScenarioCookie to Playwright's addCookies shape, resolving
 * `$ENV:VAR` in the value. Playwright needs either `url` or `domain`+`path`:
 * with an explicit `domain` we pass it plus `path` (default `/`); otherwise we
 * derive from `baseUrl` — `url: baseUrl` when no `path`, or the baseUrl host +
 * the given `path` when a path is set.
 */
export function toPlaywrightCookie(c: ScenarioCookie, baseUrl: string): AddCookieParam {
  const cookie: AddCookieParam = { name: c.name, value: resolveEnvValue(c.value) };
  if (c.expires !== undefined) cookie.expires = c.expires;
  if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly;
  if (c.secure !== undefined) cookie.secure = c.secure;
  if (c.sameSite !== undefined) cookie.sameSite = c.sameSite;
  if (c.domain) {
    cookie.domain = c.domain;
    cookie.path = c.path ?? "/";
  } else if (c.path) {
    cookie.domain = new URL(baseUrl).hostname;
    cookie.path = c.path;
  } else {
    cookie.url = baseUrl;
  }
  return cookie;
}

/** Replaces $ENV:VAR_NAME placeholders so secrets never live in committed scripts. */
export function resolveEnvValue(value: string): string {
  return value.replace(/\$ENV:([A-Z0-9_]+)/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Env var ${name} (referenciada como $ENV:${name}) não definida.`);
    return v;
  });
}

/** Runs inside the page: collects visible interactive elements + text excerpt. */
const snapshotScript = `(() => {
  const ROLE_BY_TAG = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    summary: "button", option: "option",
  };
  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", checkbox: "checkbox",
    radio: "radio", range: "slider", search: "searchbox",
  };

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[type] || "textbox";
    }
    if (tag === "a" && !el.hasAttribute("href")) return "";
    return ROLE_BY_TAG[tag] || "";
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy.split(/\\s+/)[0]);
      if (ref) return (ref.textContent || "").trim().slice(0, 80);
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return (label.textContent || "").trim().slice(0, 80);
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.trim();
      if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button") && el.value) {
        return el.value.trim();
      }
      return el.getAttribute("name") || "";
    }
    const img = el.querySelector("img[alt]");
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    return (text || (img ? img.getAttribute("alt") : "") || el.getAttribute("title") || "").slice(0, 80);
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      const tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + "#" + CSS.escape(node.id));
        break;
      }
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  const selector = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);
  const seen = new Set();
  const elements = [];
  let ref = 1;
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    const role = roleOf(el);
    const name = nameOf(el);
    if (!role && !name) continue;
    const info = { ref: ref++, role: role || el.tagName.toLowerCase(), name, css: cssPath(el), tag: el.tagName.toLowerCase() };
    if (el.tagName === "INPUT" && el.type !== "password" && el.value) info.value = String(el.value).slice(0, 40);
    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) info.href = href.slice(0, 80);
    }
    elements.push(info);
    if (elements.length >= 120) break;
  }

  const text = (document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 2500);
  return { elements, text };
})()`;
