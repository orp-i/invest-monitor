#!/usr/bin/env node
// Stages a sanitized copy of this repository suitable for a public mirror: an explicit allowlist of
// paths (never "everything except X" — anything not listed below is simply never read), then a deny-list
// scan of every copied text file for internal hosts, local paths and secret-shaped strings. Exits non-zero
// and lists every match (file:line) if anything trips the deny-list, in both modes.
//
// Usage:
//   node scripts/prepare-public-release.mjs [--out dist-release/public]   copy + scan
//   node scripts/prepare-public-release.mjs --check [--out dist-release/public]   scan only, against the
//     current tree's source files (nothing is written); --out is accepted but unused in this mode.
import { existsSync, readFileSync } from "node:fs";
import { open, readdir, readFile, stat, mkdir, cp, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT = "dist-release/public";

// Directories copied in full (minus build/dependency output, pruned during the walk below).
const INCLUDE_DIRS = ["apps", "packages", "tests", "docker", "packaging", ".github"];
// Individual files copied as-is when present; missing ones are reported, not treated as errors, since
// some (README.en.md, SECURITY.md, LICENSE) are owned by other in-flight work on this repository.
const INCLUDE_FILES = [
  ".env.example",
  ".dockerignore",
  ".gitignore",
  "Dockerfile",
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "config/portfolio.example.yaml",
];
// Root-level glob families (docker-compose.yml + docker-compose.*.yml, tsconfig.json + tsconfig.*.json).
const ROOT_GLOB_PATTERNS = [/^docker-compose.*\.ya?ml$/, /^tsconfig.*\.json$/];
// scripts/ is included, minus internal-only maintenance/verification scripts that assume this specific
// deployment (production probes, one-off content importers, browser-driven verification harnesses).
const SCRIPTS_EXCLUDE = [/^verify-.*\.mjs$/, "release-denylist.private.json", "probe-tradier-orders.mjs", "review-market-daily.mjs", "enrich-market-daily.mjs", "import-research-content.mjs", "publish-public-repo.sh"];
// docs/: only these files are public-facing operator docs; everything else under docs/ (handoffs, design
// scratch notes, research-run logs, etc.) is internal working material and stays out of the mirror.
const DOCS_ALLOW = [
  "INSTALL.md", "SETTINGS.md", "BROKERS.md", "RISK-EXPOSURE.md", "TRADIER-MARKET-DATA.md",
  "CHARTS.md", "STORAGE-PERFORMANCE.md", "TRADING-REVIEW.md", "MARKET-DAILY.md",
  "DAILY-INFERENCE.md", "RESEARCH-ARCHITECTURE.md",
];
// Private material that lives inside otherwise-public directories: the shipped learning-package copy under the
// web public dir and the tests that read the private research content packs.
const PATH_EXCLUDE = ["apps/web/public/trading-review/", "tests/workspace/geopolitical-content.test.ts", "tests/workspace/research-content.test.ts"];
const PRUNE_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
const PRUNE_FILE_SUFFIXES = [".tsbuildinfo"];

// Never published: anything shaped like a live API key or private key, real e-mail addresses, and the
// deployment-specific fragments listed in scripts/release-denylist.private.json (which itself never ships:
// it names the operator's own account/address fragments). Generic patterns live here.
const GENERIC_DENY_PATTERNS = [
  { name: "API-key-shaped string", source: "sk-[A-Za-z0-9]{16,}" },
  { name: "GitHub token", source: "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}" },
  { name: "private key block", source: "-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY" },
  { name: "AWS access key", source: "AKIA[0-9A-Z]{16}" },
  { name: "e-mail address", source: "[A-Za-z0-9._%+-]+@(?!example\\.|noreply)[A-Za-z0-9.-]+\\.(com|cn|io|net|org)\\b" },
  { name: "CGNAT/VPN mesh address", source: "\\b100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d+\\.\\d+\\b" },
];
const PRIVATE_DENY_FILE = "scripts/release-denylist.private.json";
function loadPrivateDenyPatterns() {
  const path = join(REPO_ROOT, PRIVATE_DENY_FILE);
  if (!existsSync(path)) return [];
  const rows = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${PRIVATE_DENY_FILE} must be a JSON array of { name, source }`);
  return rows.map((p) => ({ name: String(p.name), source: String(p.source) }));
}
const DENY_PATTERNS = [...GENERIC_DENY_PATTERNS, ...loadPrivateDenyPatterns()].map((p) => ({ name: p.name, re: new RegExp(p.source) }));

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string", default: DEFAULT_OUT }, check: { type: "boolean", default: false } },
  });
  return { outDir: resolve(REPO_ROOT, values.out), check: values.check === true };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function matchesAny(name, patterns) {
  return patterns.some((p) => (p instanceof RegExp ? p.test(name) : p === name));
}

/** Recursively lists files under `absDir`, pruning node_modules/dist/.git and *.tsbuildinfo as it goes. */
async function walkFiles(absDir, relPrefix, out) {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return; // absDir does not exist: nothing to include, not an error (some inputs are optional)
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (PRUNE_DIR_NAMES.has(entry.name)) continue;
      await walkFiles(abs, rel, out);
    } else if (entry.isFile()) {
      if (PRUNE_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      out.push({ src: abs, rel });
    }
  }
}

/** The full {src, rel} allowlist, computed from the source tree. `rel` is always forward-slashed. */
async function collectEntries() {
  const entries = [];
  const missingOptional = [];

  for (const dir of INCLUDE_DIRS) {
    if (!(await pathExists(join(REPO_ROOT, dir)))) {
      missingOptional.push(`${dir}/`);
      continue;
    }
    await walkFiles(join(REPO_ROOT, dir), dir, entries);
  }

  const scriptsDir = join(REPO_ROOT, "scripts");
  for (const name of await readdir(scriptsDir).catch(() => [])) {
    if (matchesAny(name, SCRIPTS_EXCLUDE)) continue;
    const abs = join(scriptsDir, name);
    if ((await stat(abs)).isFile()) entries.push({ src: abs, rel: `scripts/${name}` });
  }

  for (const rel of INCLUDE_FILES) {
    const abs = join(REPO_ROOT, rel);
    if (await pathExists(abs)) entries.push({ src: abs, rel });
    else missingOptional.push(rel);
  }

  for (const name of await readdir(REPO_ROOT)) {
    if (!ROOT_GLOB_PATTERNS.some((re) => re.test(name))) continue;
    const abs = join(REPO_ROOT, name);
    if ((await stat(abs)).isFile()) entries.push({ src: abs, rel: name });
  }

  for (const name of DOCS_ALLOW) {
    const abs = join(REPO_ROOT, "docs", name);
    if (await pathExists(abs)) entries.push({ src: abs, rel: `docs/${name}` });
    else missingOptional.push(`docs/${name}`);
  }
  await walkFiles(join(REPO_ROOT, "docs/screenshots"), "docs/screenshots", entries);

  const published = entries.filter((entry) => !PATH_EXCLUDE.some((prefix) => entry.rel === prefix || entry.rel.startsWith(prefix)));
  published.sort((a, b) => a.rel.localeCompare(b.rel));
  return { entries: published, missingOptional };
}

async function isBinary(absPath) {
  const handle = await open(absPath, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Scans one file's text content for every deny pattern; returns "rel:line: message" strings. */
async function scanFile(absPath, rel) {
  if (await isBinary(absPath)) return [];
  const text = await readFile(absPath, "utf8");
  const lines = text.split(/\r\n|\r|\n/);
  const hits = [];
  lines.forEach((line, index) => {
    for (const { name, re } of DENY_PATTERNS) {
      if (re.test(line)) hits.push(`${rel}:${index + 1}: matched ${name} (/${re.source}/)`);
    }
  });
  return hits;
}

async function scanAll(entries) {
  const hits = [];
  for (const entry of entries) {
    // This script's own source is exempt: DENY_PATTERNS above necessarily spells out each pattern as a
    // literal string, which would otherwise always flag itself. It never contains an actual secret value,
    // only the patterns used to detect one elsewhere.
    if (entry.rel === "scripts/prepare-public-release.mjs") continue;
    hits.push(...(await scanFile(entry.dest ?? entry.src, entry.rel)));
  }
  return hits;
}

async function copyEntries(entries, outDir) {
  await rm(outDir, { recursive: true, force: true });
  for (const entry of entries) {
    const dest = join(outDir, entry.rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(entry.src, dest);
    entry.dest = dest;
  }
}

async function totalBytes(entries) {
  let total = 0;
  for (const entry of entries) total += (await stat(entry.dest ?? entry.src)).size;
  return total;
}

function printReleaseHint(outDir) {
  const rel = relative(process.cwd(), outDir) || ".";
  process.stdout.write(
    "\nNext steps to publish this tree as its own repository:\n" +
      `  cd ${rel}\n` +
      "  git init\n" +
      "  git add -A\n" +
      '  git commit -m "Initial public release"\n' +
      "  git remote add origin <your-new-public-repo-url>\n" +
      "  git push -u origin main\n",
  );
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const { entries, missingOptional } = await collectEntries();

  if (missingOptional.length > 0) {
    process.stdout.write(`Not present in this tree, skipped (not an error):\n${missingOptional.map((p) => `  - ${p}`).join("\n")}\n\n`);
  }

  if (args.check) {
    process.stdout.write(`Scanning ${entries.length} files in place (--check, nothing written)...\n`);
    const hits = await scanAll(entries);
    if (hits.length > 0) {
      process.stderr.write(`\nDeny-list scan FAILED - ${hits.length} match(es):\n${hits.map((h) => `  ${h}`).join("\n")}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("Deny-list scan passed - no internal addresses, credential fragments or local paths found.\n");
    return;
  }

  process.stdout.write(`Copying ${entries.length} files to ${args.outDir}...\n`);
  await copyEntries(entries, args.outDir);

  process.stdout.write("Scanning the copied tree...\n");
  const hits = await scanAll(entries);
  if (hits.length > 0) {
    process.stderr.write(
      `\nDeny-list scan FAILED - ${hits.length} match(es). ${args.outDir} was written but must NOT be published as-is:\n` +
        `${hits.map((h) => `  ${h}`).join("\n")}\n` +
        "\nFix the source file(s) above and re-run this script.\n",
    );
    process.exitCode = 1;
    return;
  }

  const bytes = await totalBytes(entries);
  process.stdout.write(
    `\nPrepared ${entries.length} files (${(bytes / (1024 * 1024)).toFixed(1)} MiB) at ${args.outDir}.\n` +
      "Deny-list scan passed - no internal addresses, credential fragments or local paths found.\n",
  );
  printReleaseHint(args.outDir);
}

await main();
