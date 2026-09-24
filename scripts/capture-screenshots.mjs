// Captures masked screenshots of the workbench for the public README/docs.
//
// This script never writes to the target server: every /api/** request the page makes is intercepted
// (see newPage() below); GETs are re-issued from Node with the CLI Bearer token and the response is
// relayed back to the page, everything else is answered locally with a 403 and never reaches the
// server. This mirrors the auth/proxy pattern in scripts/verify-risk-exposure-browser.mjs.
//
// Playwright is not a dependency of this package: point INVEST_PLAYWRIGHT_MODULE at a `playwright-core`
// install and INVEST_CHROMIUM_PATH at a Chromium binary (e.g. one downloaded by `npx playwright install
// chromium` in a scratch directory). No browser path is hardcoded here on purpose.
//
// Usage:
//   node scripts/capture-screenshots.mjs --url http://127.0.0.1:8080 --out docs/screenshots [--full-page]
//   node scripts/capture-screenshots.mjs --replace "U1234567=ACCOUNT-1" --replace "8812345=8800000"
//
// Before each screenshot the script runs an in-page masking pass (maskPageSource, evaluated inside the
// browser): digit sequences in text nodes are replaced with random digits of the same length, except
// recognisable dates/times, which are left readable; account-like alphanumeric tokens (e.g. "U1234567")
// are fully replaced (letters and digits); ticker symbols (plain letters, no digits) are never touched
// because the masking only ever looks at digit runs and mixed alnum tokens. Note that a compound token
// that mixes letters and digits throughout (e.g. a raw OCC option symbol like "AAPL260918C00150000") is
// treated as account-like and fully scrambled, prefix included — the UI normally renders a human-readable
// "underlying / expiry / strike" label instead of the raw code (see docs/TRADING-REVIEW.md), so this only
// matters if a raw code shows up somewhere; scrambling the whole thing is the conservative failure mode.
// --replace gives explicit, stable substitutions (applied with priority, and protected from the generic
// pass afterwards) for values you already know are sensitive and want a fixed, readable placeholder for.
//
// This is a best-effort text pass, not a security boundary: review the output before publishing it, and
// do not point --url at an instance holding data you would not want to double-check by eye first.

import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const ROUTES = [
  { hash: "#/overview", file: "overview.png" },
  { hash: "#/positions", file: "positions.png" },
  { hash: "#/brokers", file: "brokers.png" },
  { hash: "#/trading-review", file: "trading-review.png" },
  { hash: "#/research/daily", file: "research-daily.png" },
  { hash: "#/settings", file: "settings.png" },
  { hash: "#/options", file: "options.png" },
];

function parseArgs(argv) {
  const opts = { url: "http://127.0.0.1:8080", out: "docs/screenshots", fullPage: false, replace: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") opts.url = requireValue(argv, ++i, arg);
    else if (arg === "--out") opts.out = requireValue(argv, ++i, arg);
    else if (arg === "--full-page") opts.fullPage = true;
    else if (arg === "--replace") {
      const raw = requireValue(argv, ++i, arg);
      const eq = raw.indexOf("=");
      if (eq <= 0) throw new Error(`--replace expects FIND=REPLACE, got: ${JSON.stringify(raw)}`);
      opts.replace.push([raw.slice(0, eq), raw.slice(eq + 1)]);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  opts.url = opts.url.replace(/\/+$/, "");
  return opts;
}
function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

// Evaluated inside the page via page.evaluate — must be self-contained (no closure over outer scope).
// Walks text nodes plus a few label/value attributes (a safety net beyond the text-node requirement, so
// a masked-secret tail surfacing in an input placeholder still gets caught) and replaces digits with
// random digits of the same length, except recognisable dates/times. `replacements` (an array of
// [find, replace] pairs) is matched first, verbatim, and its output is left untouched by the rest of the
// pass; everything else falls through to date/time protection, then account-like token replacement,
// then plain digit randomization. Only digit characters are ever substituted for the generic case, so
// punctuation, minus signs, "%" and decimal points are preserved as-is (this is what keeps percentage
// formatting intact), and ticker symbols (pure letters) are never matched at all.
function maskPageSource(replacements) {
  const explicit = new Map(replacements);
  const randDigit = () => String(Math.floor(Math.random() * 10));
  const randLetter = (upper) => {
    const c = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    return upper ? c : c.toLowerCase();
  };
  const randomizeDigits = (s) => s.replace(/\d/g, randDigit);
  const randomizeToken = (s) => s.replace(/[A-Za-z]/g, (c) => randLetter(c === c.toUpperCase())).replace(/\d/g, randDigit);

  // Recognised as "leave alone" so screenshots stay readable: ISO datetimes, plain dates, 8-digit
  // YYYYMMDD dates, Chinese "N年[N月[N日]]" dates, and HH:MM[:SS] clock times.
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const yyyymmdd = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
  const cnDate = /^\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?$/;
  const clockTime = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  const slashDate = /^\d{4}\/\d{1,2}\/\d{1,2}$/;
  // Mixed letter+digit tokens shaped like a brokerage account id (e.g. "U1234567", "DU123456").
  const accountLike = /^[A-Za-z]{1,4}\d{4,}[A-Za-z0-9]*$/;

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicitKeys = [...explicit.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const alternatives = [
    ...(explicitKeys.length ? [explicitKeys.join("|")] : []),
    String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?`,
    String.raw`\d{4}-\d{2}-\d{2}`,
    String.raw`\d{4}\/\d{1,2}\/\d{1,2}`,
    String.raw`\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b`,
    String.raw`\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?`,
    String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`,
    String.raw`\b[A-Za-z]{1,4}\d{4,}[A-Za-z0-9]*\b`,
    String.raw`\d+`,
  ];
  const master = new RegExp(alternatives.join("|"), "g");

  function maskString(input) {
    if (!input) return input;
    // A masked secret still ends with its real last characters ("••••••••abc7"): hide the tail completely.
    input = input.replace(/\u2022{4,}[A-Za-z0-9]{1,4}/g, "\u2022".repeat(12));
    if (!/\d/.test(input)) return input;
    return input.replace(master, (match) => {
      if (explicit.has(match)) return explicit.get(match);
      if (isoDateTime.test(match) || isoDate.test(match) || slashDate.test(match) || yyyymmdd.test(match) || cnDate.test(match) || clockTime.test(match)) return match;
      if (accountLike.test(match)) return randomizeToken(match);
      return randomizeDigits(match);
    });
  }

  const skipTag = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return !parent || skipTag.has(parent.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let textNodes = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = maskString(node.nodeValue);
    if (next !== node.nodeValue) { node.nodeValue = next; textNodes++; }
  }

  // Beyond the text-node requirement: masked-secret tails and similar values can also surface in
  // placeholder/title/aria-label/value attributes (e.g. an input showing "已配置 ••••••••1234").
  let attrs = 0;
  for (const el of document.querySelectorAll("[placeholder],[title],[aria-label],input,textarea")) {
    for (const name of ["placeholder", "title", "aria-label"]) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const next = maskString(value);
      if (next !== value) { el.setAttribute(name, next); attrs++; }
    }
    if (((el instanceof HTMLInputElement && el.type !== "password") || el instanceof HTMLTextAreaElement) && el.value) {
      const next = maskString(el.value);
      if (next !== el.value) { el.value = next; attrs++; }
    }
  }
  return { textNodes, attrs };
}

async function loadPlaywright() {
  const moduleSpecifier = process.env.INVEST_PLAYWRIGHT_MODULE || "playwright-core";
  try {
    const mod = await import(moduleSpecifier);
    return mod.chromium;
  } catch (error) {
    throw new Error(`could not load playwright-core from "${moduleSpecifier}" (set INVEST_PLAYWRIGHT_MODULE to its entry point): ${error.message}`);
  }
}

async function readToken(root) {
  const path = resolve(root, "secrets/ui_auth_token");
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`could not read ${path} (${error.code ?? error.message}); create it first: openssl rand -hex 24 > secrets/ui_auth_token`); }
  const token = raw.trim();
  if (!token) throw new Error(`${path} is empty`);
  return token;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(import.meta.dirname, "..");
  const outDir = resolve(root, opts.out);
  await mkdir(outDir, { recursive: true });
  const token = await readToken(root);

  const chromium = await loadPlaywright();
  const executablePath = process.env.INVEST_CHROMIUM_PATH;
  if (!executablePath) console.warn("INVEST_CHROMIUM_PATH is not set; relying on Playwright's own Chromium lookup, which may fail for a playwright-core-only install.");

  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const written = [];
  try {
    async function newPage(viewport) {
      const page = await browser.newPage({ viewport, colorScheme: "dark" });
      page.on("pageerror", (error) => console.warn(`[pageerror] ${error.message}`));
      // Every API call the page makes is re-issued here with the CLI Bearer token; non-GET requests
      // never reach the real server, so this script cannot write to whatever --url points at.
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/events") { await route.fulfill({ contentType: "text/event-stream", body: ": screenshot\n\n" }); return; }
        if (url.pathname === "/api/market/interest") { await route.fulfill({ json: { accepted: true } }); return; }
        if (request.method() !== "GET") { await route.fulfill({ status: 403, json: { message: "read-only screenshot session" } }); return; }
        try {
          const upstream = await fetch(opts.url + url.pathname + url.search, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
          const body = await upstream.text();
          await route.fulfill({ status: upstream.status, contentType: upstream.headers.get("content-type") ?? "application/json", body });
        } catch (error) {
          await route.fulfill({ status: 503, json: { message: String(error) } }).catch(() => {});
        }
      });
      return page;
    }

    async function shoot(page, hash, filePath, locatorSelector) {
      await page.goto(`${opts.url}/${hash}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800); // let React settle and charts finish their first paint
      // Environment banners (SSE stub notice, initial-password reminder, update prompt) are not part of the product surface.
      await page.addStyleTag({ content: ".stream-banner, .password-warning, .web-update-notice { display: none !important; }" });
      const summary = await page.evaluate(maskPageSource, opts.replace);
      console.log(`masked ${hash}: ${summary.textNodes} text nodes, ${summary.attrs} attributes changed`);
      if (locatorSelector) {
        const locator = page.locator(locatorSelector).first();
        if ((await locator.count()) === 0) { console.warn(`selector not found, skipping ${filePath}: ${locatorSelector}`); return; }
        await locator.screenshot({ path: filePath });
      } else {
        await page.screenshot({ path: filePath, fullPage: opts.fullPage });
      }
      written.push(filePath);
    }

    const desktop = await newPage({ width: 1440, height: 900 });
    for (const route of ROUTES) await shoot(desktop, route.hash, resolve(outDir, route.file));
    // The risk-exposure card lives inside the overview page rather than at its own route; capture it as
    // a focused crop in addition to the full overview screenshot taken above.
    await shoot(desktop, "#/overview", resolve(outDir, "risk-exposure.png"), ".risk-exposure");
    await desktop.close();

    const mobile = await newPage({ width: 390, height: 844 });
    await shoot(mobile, "#/overview", resolve(outDir, "overview-390.png"));
    await mobile.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ out: outDir, files: written.map((f) => f.slice(root.length + 1)) }, null, 1));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
