import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type {
  ElementStateMatcher,
  NetworkMatcher,
  PermissionPolicy,
  ScenarioCookie,
  ScenarioStorage,
  Step,
  Target,
} from "../types.js";
import type { ResolvedViewport } from "../viewports.js";
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
  /**
   * Resolved viewport for this run — sizes the context (and any recorded video)
   * and carries the device emulation (deviceScaleFactor/isMobile/hasTouch/UA).
   */
  viewport: ResolvedViewport;
  /** Record a WebM of the context (used only by the demo-video replay) */
  recordVideo?: boolean;
  /**
   * Inject a synthetic cursor + click pulse (used only by the demo-video replay)
   * so a viewer can see what each step acts on. Best-effort overlay, captured
   * natively by recordVideo — never affects the verdict.
   */
  demoCursor?: boolean;
  /** Playwright slowMo (ms/action) — paces the demo replay for human viewing */
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
   * Web storage to seed before the app loads (profile + scenario, already
   * merged). Applied via a context init-script that runs before any page
   * script, AFTER storageState — so declared storage wins over the profile's.
   * Values may carry a `$ENV:VAR` placeholder, resolved here at launch.
   */
  storage?: ScenarioStorage;
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

/**
 * Builds the init-script that injects a synthetic cursor + click pulse for the
 * demo video. Playwright's recorded video never captures the OS pointer, so the
 * UI would otherwise change with no visible cause; this paints a session-replay
 * style cursor (Clarity/Sentry feel) that the recording captures natively.
 *
 * Injected at the context level so `window.__scoutCursor` re-exists after every
 * navigation; the DOM element is (re)created lazily on the first `move()` since
 * a `goto` wipes the previous document. `pointer-events:none` + a very high
 * z-index guarantee it sits on top yet can never intercept the real click, so
 * the overlay cannot perturb the flow it is filming.
 */
export function demoCursorStub(): string {
  return `(() => {
    if (window.top !== window.self) return; // top frame only — skip iframes
    const CURSOR_ID = "__scout-cursor";
    const STYLE_ID = "__scout-cursor-style";
    let x = window.innerWidth / 2, y = window.innerHeight / 2;
    function ensure() {
      if (!document.body) return null;
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
          "#" + CURSOR_ID + "{position:fixed;top:0;left:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(0,0,0,.35);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;will-change:transform;}" +
          // Positioned via left/top (NOT transform) so the scale keyframe, which
          // owns the transform property, can't clobber its placement to (0,0).
          ".__scout-ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid #2ECC71;z-index:2147483646;pointer-events:none;animation:__scout-ripple .55s ease-out forwards;}" +
          "@keyframes __scout-ripple{from{transform:scale(1);opacity:.9;}to{transform:scale(3.6);opacity:0;}}";
        (document.head || document.documentElement).appendChild(style);
      }
      let el = document.getElementById(CURSOR_ID);
      if (!el) {
        el = document.createElement("div");
        el.id = CURSOR_ID;
        el.style.transform = "translate(" + x + "px," + y + "px)";
        document.body.appendChild(el);
      }
      return el;
    }
    window.__scoutCursor = {
      move(nx, ny, durMs) {
        const el = ensure();
        if (!el) return;
        el.style.transition = "transform " + (durMs || 0) + "ms cubic-bezier(.4,0,.2,1)";
        x = nx; y = ny;
        el.style.transform = "translate(" + nx + "px," + ny + "px)";
      },
      pulse() {
        const el = ensure();
        if (!el || !document.body) return;
        const r = document.createElement("div");
        r.className = "__scout-ripple";
        r.style.left = x + "px";
        r.style.top = y + "px";
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 700);
        el.style.background = "rgba(46,204,113,.5)";
        setTimeout(() => { el.style.background = "rgba(0,0,0,.35)"; }, 240);
      },
    };
  })();`;
}

/**
 * Pool of shared Chromium Browser processes, keyed by the launch-time options
 * that cannot be changed per-context: `${headless}|${slowMoMs}`. A full
 * `chromium.launch()` is the expensive part; within one process (the CLI `go`
 * loop over scenarios/viewports, or the long-lived MCP server across tool
 * calls) we launch once per key and reuse the process, opening a fresh isolated
 * BrowserContext per BrowserSession — the context is the isolation boundary.
 *
 * slowMo is a launch-time option: the paced demo replay needs its own pooled
 * browser, and both demo attempts (paced + fallback share the same slowMo=0 for
 * the fallback / the paced value for the first) plus subsequent scenarios reuse
 * whichever they key into.
 *
 * The map stores the launch PROMISE (not the resolved Browser) so two
 * concurrent launch() calls with the same key share one launch instead of
 * racing into two Chromium processes.
 */
const browserPool = new Map<string, Promise<Browser>>();

function poolKey(headless: boolean, slowMoMs: number | undefined): string {
  return `${headless}|${slowMoMs ?? 0}`;
}

/**
 * Returns a shared Browser for the given launch options, launching one on first
 * use and reusing it thereafter. If a pooled browser has since disconnected
 * (crash, or an external close), its entry is dropped and a fresh browser is
 * launched.
 */
async function acquireBrowser(headless: boolean, slowMoMs: number | undefined): Promise<Browser> {
  const key = poolKey(headless, slowMoMs);
  // Reuse a live pooled entry; drop a stale/failed one and launch a fresh
  // browser. The map is only ever written synchronously (no await between the
  // decision to claim `key` and the set below), so two concurrent callers that
  // both find the same stale entry can't both launch: the first to resume
  // claims the key, the second re-reads the map and awaits that fresh launch.
  for (;;) {
    const existing = browserPool.get(key);
    if (!existing) break;
    let browser: Browser | undefined;
    try {
      browser = await existing;
    } catch {
      browser = undefined; // a prior pooled launch failed — relaunch below
    }
    if (browser?.isConnected()) return browser;
    // Stale/failed. Evict by identity: only drop it if it's still the mapped
    // entry, so we never discard a fresh browser a concurrent caller just
    // installed under this key. If the map already changed, loop to re-read it.
    if (browserPool.get(key) === existing) {
      browserPool.delete(key);
      break;
    }
  }
  const launched = chromium.launch({ headless, slowMo: slowMoMs });
  browserPool.set(key, launched);
  // If the launch itself rejects, don't leave a rejected promise cached — the
  // next call should get a clean retry. Delete by identity so a rejecting
  // orphaned launch can't evict a healthy replacement mapped under the same key.
  launched.catch(() => {
    if (browserPool.get(key) === launched) browserPool.delete(key);
  });
  return launched;
}

/**
 * Closes every pooled Browser process and clears the pool. Call this before a
 * process that ran scenarios exits (the CLI `go` command, a library consumer
 * looping runScenario) — otherwise the live browser keeps the Node event loop
 * alive and the process never exits. Errors are tolerated: a browser that is
 * already gone is not a failure to close.
 */
export async function closeBrowsers(): Promise<void> {
  const pending = Array.from(browserPool.values());
  browserPool.clear();
  await Promise.all(
    pending.map((p) => p.then((b) => b.close()).catch(() => {}))
  );
}

const STEP_TIMEOUT = 10_000;

/**
 * Cap on the "let the page settle" wait of one-shot presence checks. Network
 * idle usually resolves immediately on a loaded page; the cap only exists so
 * an app with permanent background traffic can't stall the fast path.
 */
const SETTLE_TIMEOUT = 2_000;

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
    // Reuse a pooled Chromium process (launched once per headless|slowMo key);
    // isolation is provided by the fresh context created below, not by a new
    // browser process.
    const browser = await acquireBrowser(opts.headless, opts.slowMoMs);
    const perm = opts.permissions;
    const vp = opts.viewport;
    const size = { width: vp.width, height: vp.height };
    const context = await browser.newContext({
      locale: opts.locale ?? "pt-BR",
      viewport: size,
      ...(vp.deviceScaleFactor != null ? { deviceScaleFactor: vp.deviceScaleFactor } : {}),
      ...(vp.isMobile != null ? { isMobile: vp.isMobile } : {}),
      ...(vp.hasTouch != null ? { hasTouch: vp.hasTouch } : {}),
      ...(vp.userAgent != null ? { userAgent: vp.userAgent } : {}),
      storageState: opts.storageState,
      ...(opts.extraHeaders ? { extraHTTPHeaders: opts.extraHeaders } : {}),
      ...(perm?.grant?.length ? { permissions: perm.grant } : {}),
      ...(perm?.geolocation ? { geolocation: perm.geolocation } : {}),
      ...(opts.recordVideo ? { recordVideo: { dir: opts.runDir, size } } : {}),
    });
    // Deny stub must run before any page script and in every page (incl. popups).
    if (perm?.deny?.length) await context.addInitScript(denyPermissionsStub(perm.deny));
    // Seed declared cookies before any navigation, so the server reads them on
    // the very first request (e.g. a server-side experiment variant). After
    // storageState load → declared cookies win over the auth session by name.
    if (opts.cookies?.length) {
      await context.addCookies(opts.cookies.map((c) => toPlaywrightCookie(c, opts.baseUrl)));
    }
    // Seed web storage before any page script (covers sessionStorage, which
    // storageState does not carry), AFTER the storageState load so declared
    // storage wins over the profile's — same ordering as cookies. `$ENV:VAR`
    // in values is resolved here at launch, never persisted resolved.
    if (opts.storage) {
      const script = buildStorageInitScript(opts.storage);
      if (script) await context.addInitScript(script);
    }
    // Demo cursor stub: a context init-script so the cursor API re-exists after
    // every navigation (the element itself is re-created lazily on first move).
    if (opts.demoCursor) await context.addInitScript(demoCursorStub());
    const videoEpoch = opts.recordVideo ? Date.now() : undefined;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    const session = new BrowserSession(context, page, opts, videoEpoch);
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
        reject(new Error(`No tab with a URL matching "${urlGlob}" within ${STEP_TIMEOUT}ms.`));
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
      throw new Error(`Ref [${ref}] unknown — take a new browser_snapshot, the page changed.`);
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

  /**
   * Clicks an element located directly by data-testid or CSS — no snapshot ref
   * involved. This is the escape hatch for elements OUTSIDE the accessibility
   * tree (a gesture layer, an overlay `<div>` with only a data-testid): they
   * never get a numbered [ref], so ref-based click can't reach them. Returns the
   * durable Target so the caller records a deterministic `click` step (the same
   * kind as a ref click — one replay path, testId/css resolved by targetLocator).
   */
  async clickSelector(sel: { testId?: string; css?: string }): Promise<Target> {
    const target = buildSelectorTarget(sel);
    await this.targetLocator(target).click();
    return target;
  }

  /**
   * Asserts an element's VISUAL/structural state (class token, attribute,
   * computed style) — the check text/URL assertions can't express. Polls until
   * every provided condition holds or `timeout` elapses, so it is deterministic
   * on replay. The canonical use is the opacity toggle: a control kept in the DOM
   * but hidden with `opacity:0` (which Playwright still reports as "visible", so
   * assertNotVisible would false-pass) — assert `opacity-0`/computed opacity
   * instead. The element must at least be attached; a missing element fails.
   */
  async assertState(target: Target, checks: ElementStateMatcher, timeout = STEP_TIMEOUT): Promise<void> {
    if (
      checks.hasClass === undefined &&
      checks.notHasClass === undefined &&
      checks.attribute === undefined &&
      checks.computedStyle === undefined
    ) {
      throw new Error("assertState needs at least one of hasClass/notHasClass/attribute/computedStyle.");
    }
    const locator = this.targetLocator(target);
    await locator.waitFor({ state: "attached", timeout }).catch(() => {
      throw new Error(`Element ${target.description} not found within ${timeout}ms.`);
    });
    const styleProp = checks.computedStyle?.property ?? null;
    const deadline = Date.now() + timeout;
    let lastReason = "";
    for (;;) {
      const observed = await locator
        .evaluate(
          (el, prop) => ({
            classes: Array.from((el as Element).classList),
            attrs: Object.fromEntries(Array.from((el as Element).attributes).map((a) => [a.name, a.value])),
            styleValue: prop ? getComputedStyle(el as Element).getPropertyValue(prop).trim() : null,
          }),
          styleProp
        )
        .catch(() => null);
      if (observed) {
        lastReason = describeStateMismatch(target, checks, observed);
        if (!lastReason) return; // every provided check holds
      }
      if (Date.now() >= deadline) {
        throw new Error(
          lastReason || `Could not read the state of ${target.description} within ${timeout}ms.`
        );
      }
      await this.page.waitForTimeout(100);
    }
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

  /**
   * Dispatches a wheel gesture at (x, y) — viewport center when omitted, since
   * wheel events fire at the current mouse position and (0,0) may sit outside
   * the scroll container the gesture is meant for. The center is derived from
   * the resolved viewport, so a recorded step without coordinates replays at
   * the same spot (viewport is part of the run identity).
   */
  async wheel(deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
    const vp = this.opts.viewport;
    await this.page.mouse.move(x ?? Math.round(vp.width / 2), y ?? Math.round(vp.height / 2));
    await this.page.mouse.wheel(deltaX, deltaY);
  }

  /**
   * Drags the mouse from one point to another (down → move → up), emulating a
   * swipe/drag gesture. The move is split into intermediate events so handlers
   * that track movement deltas (drag-to-dismiss, swipe navigation) see a
   * realistic gesture instead of a single jump.
   */
  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.page.mouse.move(fromX, fromY);
    await this.page.mouse.down();
    await this.page.mouse.move(toX, toY, { steps: 12 });
    await this.page.mouse.up();
  }

  async waitForText(text: string, timeout = STEP_TIMEOUT): Promise<void> {
    await this.page.getByText(text).first().waitFor({ state: "visible", timeout });
  }

  async waitForUrl(pattern: string, timeout = STEP_TIMEOUT): Promise<void> {
    await this.page.waitForURL((u) => u.toString().includes(pattern), { timeout });
  }

  /**
   * Asserts a text is visible. Default is Playwright's polling wait (up to
   * `timeout`, STEP_TIMEOUT when omitted) — right for content that may still
   * be loading. `oneShot` is the fast path for content that should already be
   * on a loaded page: let the page settle (network idle, capped so a chatty
   * app can't stall the check) and probe visibility ONCE, so a definitive miss
   * costs ~1-2s instead of the full poll — mirroring assertNotVisible.
   */
  async assertVisible(
    text: string,
    opts: { timeout?: number; oneShot?: boolean } = {}
  ): Promise<void> {
    if (opts.oneShot) {
      await this.page
        .waitForLoadState("networkidle", { timeout: Math.min(opts.timeout ?? SETTLE_TIMEOUT, SETTLE_TIMEOUT) })
        .catch(() => {}); // settled "enough" — the probe below is the judgment
      const visible = await this.page
        .getByText(text)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) throw new Error(`Text "${text}" is not visible (one-shot check after settle).`);
      return;
    }
    await this.page
      .getByText(text)
      .first()
      .waitFor({ state: "visible", timeout: opts.timeout ?? STEP_TIMEOUT });
  }

  async assertNotVisible(text: string, timeout?: number): Promise<void> {
    // give the page a beat to render, then require absence
    await this.page.waitForTimeout(timeout ?? 1000);
    const visible = await this.page
      .getByText(text)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) throw new Error(`Text "${text}" is visible, but it should not be.`);
  }

  /**
   * Asserts the current URL contains the pattern. Instant one-shot by default
   * (backward compatible); with `timeout` it tolerates an in-flight redirect
   * by waiting up to that long for the URL to match.
   */
  async assertUrl(pattern: string, timeout?: number): Promise<void> {
    if (timeout !== undefined) {
      try {
        await this.page.waitForURL((u) => u.toString().includes(pattern), { timeout });
        return;
      } catch {
        throw new Error(`Current URL "${this.page.url()}" does not contain "${pattern}" (after ${timeout}ms).`);
      }
    }
    const url = this.page.url();
    if (!url.includes(pattern)) {
      throw new Error(`Current URL "${url}" does not contain "${pattern}".`);
    }
  }

  /** Asserts an expected network call was observed. Throws with a reason on miss. */
  async assertNetwork(matcher: NetworkMatcher): Promise<void> {
    const result = await matchNetwork(this.buffers().network, matcher);
    if (!result.ok) throw new Error(result.reason ?? "Network assertion failed.");
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
      throw new Error("assertConsoleMessage requires non-empty substrings.");
    }
    const hit = this.buffers().console.find(
      (m) => (!type || m.type === type) && includes.every((s) => m.text.includes(s))
    );
    if (!hit) {
      const want = includes.map((s) => `"${s}"`).join(" + ");
      throw new Error(
        `No console message${type ? ` of type "${type}"` : ""} contained ${want}.`
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
      `Network (${networkRequests.length} requests total, last ${net.length}):`,
      ...(net.length ? net.map((l) => `  ${l}`) : ["  (none)"]),
      ``,
      `Console errors/warnings (${errs.length}):`,
      ...(errs.length ? errs.map((l) => `  ${l}`) : ["  (none)"]),
      ``,
      `Other console messages (${other.length}, for assert_console_message):`,
      ...(other.length ? other.map((l) => `  ${l}`) : ["  (none)"]),
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
      case "wheel":
        return this.wheel(step.deltaX, step.deltaY, step.x, step.y);
      case "drag":
        return this.drag(step.fromX, step.fromY, step.toX, step.toY);
      case "waitForText":
        return this.waitForText(step.text, step.timeout);
      case "waitForUrl":
        return this.waitForUrl(step.pattern, step.timeout);
      case "assertVisible":
        return this.assertVisible(step.text, { timeout: step.timeout, oneShot: step.oneShot });
      case "assertNotVisible":
        return this.assertNotVisible(step.text, step.timeout);
      case "assertState":
        return this.assertState(
          step.target,
          {
            hasClass: step.hasClass,
            notHasClass: step.notHasClass,
            attribute: step.attribute,
            computedStyle: step.computedStyle,
          },
          step.timeout
        );
      case "assertUrl":
        return this.assertUrl(step.pattern, step.timeout);
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
    // testId first: the strategy for elements outside the a11y tree (no role/name).
    if (target.testId) return this.page.getByTestId(target.testId).first();
    if (target.role && target.name) {
      return this.page
        .getByRole(target.role as Parameters<Page["getByRole"]>[0], {
          name: target.name,
          exact: true,
        })
        .first();
    }
    if (target.css) return this.page.locator(target.css);
    throw new Error(`Target has no location strategy: ${target.description}`);
  }

  /**
   * Demo overlay: animates the synthetic cursor to a target-bearing step's
   * bounding-box center and returns that center (for the timeline). Returns null
   * for steps without a target or when the element has no box. Best-effort — any
   * failure is swallowed so it can never break the demo replay (or the verdict).
   */
  async pointToStep(step: Step, travelMs = 0): Promise<{ x: number; y: number } | null> {
    if (step.kind !== "click" && step.kind !== "fill" && step.kind !== "select") return null;
    try {
      const box = await this.targetLocator(step.target).boundingBox();
      if (!box) return null;
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      await this.page.evaluate(
        ([px, py, dur]) => {
          (
            window as unknown as {
              __scoutCursor?: { move: (x: number, y: number, d: number) => void };
            }
          ).__scoutCursor?.move(px, py, dur);
        },
        [x, y, travelMs] as [number, number, number]
      );
      return { x, y };
    } catch {
      return null; // overlay is best-effort; never disturb the replay
    }
  }

  /** Demo overlay: emits a click pulse at the cursor's current position. Best-effort. */
  async pulseCursor(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        (window as unknown as { __scoutCursor?: { pulse: () => void } }).__scoutCursor?.pulse();
      });
    } catch {
      // best-effort overlay — never disturb the replay
    }
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
    // Close ONLY the context — the Browser process is shared (pooled) and reused
    // by later sessions. closeBrowsers() tears the process down at process exit.
    await this.context.close().catch(() => {});
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

/** Resolve `$ENV:VAR` in each value of a storage record (keys are left as-is). */
function resolveStorageRecord(record: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) out[key] = resolveEnvValue(value);
  return out;
}

/**
 * Builds the context init-script that seeds web storage before any page script.
 * `remove` runs first (clearing the key from BOTH localStorage and
 * sessionStorage for a clean precondition), then the declared `local`/`session`
 * values are set — so a declared value always wins over a removal of the same
 * key. Every access is wrapped so a storage-less context (about:blank, a
 * sandboxed frame) can never throw and break the run. Returns "" when nothing
 * is seeded or removed. `$ENV:VAR` in values is resolved at build time (launch).
 */
export function buildStorageInitScript(storage: ScenarioStorage): string {
  const local = resolveStorageRecord(storage.local);
  const session = resolveStorageRecord(storage.session);
  const remove = storage.remove ?? [];
  if (!Object.keys(local).length && !Object.keys(session).length && !remove.length) return "";
  return `(() => {
    try {
      const remove = ${JSON.stringify(remove)};
      const local = ${JSON.stringify(local)};
      const session = ${JSON.stringify(session)};
      for (const k of remove) {
        try { localStorage.removeItem(k); } catch (e) {}
        try { sessionStorage.removeItem(k); } catch (e) {}
      }
      for (const k in local) { try { localStorage.setItem(k, local[k]); } catch (e) {} }
      for (const k in session) { try { sessionStorage.setItem(k, session[k]); } catch (e) {} }
    } catch (e) {}
  })();`;
}

/**
 * Builds a durable Target for an element located directly by data-testid or CSS
 * (no snapshot ref). testId wins when both are given — it is the stabler handle
 * for elements outside the a11y tree. Throws when neither is provided, so a
 * selector click/assert can never silently target nothing.
 */
export function buildSelectorTarget(sel: { testId?: string; css?: string }): Target {
  if (sel.testId) return { testId: sel.testId, description: `[data-testid="${sel.testId}"]` };
  if (sel.css) return { css: sel.css, description: sel.css };
  throw new Error("A selector click/assert needs testId or css.");
}

/** The element state observed by {@link BrowserSession.assertState}'s in-page probe. */
export interface ObservedElementState {
  classes: string[];
  attrs: Record<string, string>;
  styleValue: string | null;
}

/**
 * Compares an observed element state against a matcher, returning "" when every
 * provided check holds or a human-readable reason for the FIRST failing one.
 * Pure, so it is unit-testable without a browser and shared by the live poll.
 */
export function describeStateMismatch(
  target: Target,
  checks: ElementStateMatcher,
  observed: ObservedElementState
): string {
  const where = ` on ${target.description}`;
  if (checks.hasClass !== undefined && !observed.classes.includes(checks.hasClass)) {
    return `Expected class "${checks.hasClass}"${where}, but classes are [${observed.classes.join(", ")}].`;
  }
  if (checks.notHasClass !== undefined && observed.classes.includes(checks.notHasClass)) {
    return `Class "${checks.notHasClass}" must be absent${where}, but it is present [${observed.classes.join(", ")}].`;
  }
  if (checks.attribute !== undefined) {
    const { name, value } = checks.attribute;
    const has = Object.prototype.hasOwnProperty.call(observed.attrs, name);
    if (!has) return `Expected attribute "${name}"${where}, but it is absent.`;
    if (value !== undefined && observed.attrs[name] !== value) {
      return `Expected attribute "${name}"="${value}"${where}, but it is "${observed.attrs[name]}".`;
    }
  }
  if (checks.computedStyle !== undefined) {
    const { property, value } = checks.computedStyle;
    if (observed.styleValue !== value) {
      return `Expected computed ${property}="${value}"${where}, but it is "${observed.styleValue ?? "(unread)"}".`;
    }
  }
  return "";
}

/** Replaces $ENV:VAR_NAME placeholders so secrets never live in committed scripts. */
export function resolveEnvValue(value: string): string {
  return value.replace(/\$ENV:([A-Z0-9_]+)/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Env var ${name} (referenced as $ENV:${name}) is not defined.`);
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
