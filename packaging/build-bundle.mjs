#!/usr/bin/env node
// Builds a self-contained, portable "bundle" distribution of invest-monitor: the built server + SPA, their
// production node_modules, and (unless --skip-node) an embedded Node.js runtime, packed into a single
// archive that runs after extraction via packaging/bundle/start.sh or start.cmd. See
// packaging/bundle/README.txt for what the resulting archive looks like to an end user.
//
// Usage: node packaging/build-bundle.mjs --platform <target> [--node <version>] [--out <dir>] [--skip-node]
//   --platform  linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | win-x64   (required)
//   --node      Node.js runtime version to embed, without the "v" prefix        (default: 24.14.0)
//   --out       output directory for the staged bundle and final archive        (default: dist-bundle)
//   --skip-node skip downloading/embedding the Node runtime (dev/CI dry runs; the bundle then falls back
//               to a system "node" on PATH at run time — see packaging/bundle/start.sh)
//
// Dependency-free by design: only Node built-ins, plus the "undici" package that already ships as a real
// dependency of @invest/server/@invest/egress (used here purely for its EnvHttpProxyAgent, so downloads
// respect HTTP_PROXY/HTTPS_PROXY/NO_PROXY the same way the rest of this project does), and the system
// tar/unzip/zip CLIs for archive extraction/creation.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_NODE_VERSION = "24.14.0";
const DEFAULT_OUT_DIR = "dist-bundle";

const WORKSPACE_PACKAGES = ["adapters", "collector", "config", "domain", "egress", "intel", "storage"];
const RUNTIME_SCRIPTS = [
  "import-trade-statements.mjs",
  "import-elephant-positions.mjs",
  "record-option-expiration.mjs",
  "probe-daily-llm.mjs",
];
const BUNDLE_LAUNCHER_FILES = ["start.sh", "start.cmd", "install.sh", "README.txt"];

const NODE_ASSET_BY_PLATFORM = {
  "linux-x64": { archive: (v) => `node-v${v}-linux-x64.tar.gz`, kind: "tar" },
  "linux-arm64": { archive: (v) => `node-v${v}-linux-arm64.tar.gz`, kind: "tar" },
  "darwin-x64": { archive: (v) => `node-v${v}-darwin-x64.tar.gz`, kind: "tar" },
  "darwin-arm64": { archive: (v) => `node-v${v}-darwin-arm64.tar.gz`, kind: "tar" },
  "win-x64": { archive: (v) => `node-v${v}-win-x64.zip`, kind: "zip" },
};

function log(message) {
  process.stderr.write(`[build-bundle] ${message}\n`);
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      platform: { type: "string" },
      node: { type: "string", default: DEFAULT_NODE_VERSION },
      out: { type: "string", default: DEFAULT_OUT_DIR },
      "skip-node": { type: "boolean", default: false },
    },
  });
  if (!values.platform || !NODE_ASSET_BY_PLATFORM[values.platform]) {
    const allowed = Object.keys(NODE_ASSET_BY_PLATFORM).join(", ");
    throw new Error(`--platform is required and must be one of: ${allowed} (got ${values.platform ?? "(none)"})`);
  }
  return {
    platform: values.platform,
    nodeVersion: values.node.replace(/^v/i, ""),
    outDir: resolve(process.cwd(), values.out),
    skipNode: values["skip-node"] === true,
  };
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}${options.cwd ? `  (cwd: ${options.cwd})` : ""}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureServerBuilt() {
  if (await pathExists(join(REPO_ROOT, "apps/server/dist"))) return;
  log("apps/server/dist is missing; running `npm run build` first");
  run("npm", ["run", "build"], { cwd: REPO_ROOT });
}

async function readBundleVersion() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "apps/server/package.json"), "utf8"));
  if (!pkg.version) throw new Error("apps/server/package.json has no version field");
  return pkg.version;
}

/** Stages just what a production install needs: package.json + dist (+ schema.sql for storage). */
async function stageWorkspacePackages(stageDir) {
  for (const name of WORKSPACE_PACKAGES) {
    const src = join(REPO_ROOT, "packages", name);
    const dest = join(stageDir, "packages", name);
    await mkdir(dest, { recursive: true });
    await cp(join(src, "package.json"), join(dest, "package.json"));
    await cp(join(src, "dist"), join(dest, "dist"), { recursive: true });
  }
  // Belt and suspenders: readSchemaSql() in packages/storage/src/sqlite.ts checks both dist/schema.sql
  // (already copied above, per that package's own build script) and ../schema.sql relative to dist/.
  await cp(
    join(REPO_ROOT, "packages/storage/schema.sql"),
    join(stageDir, "packages/storage/schema.sql"),
  );
}

async function stageServer(stageDir) {
  const dest = join(stageDir, "apps/server");
  await mkdir(dest, { recursive: true });
  await cp(join(REPO_ROOT, "apps/server/package.json"), join(dest, "package.json"));
  await cp(join(REPO_ROOT, "apps/server/dist"), join(dest, "dist"), { recursive: true });
}

async function stageWeb(stageDir) {
  const dest = join(stageDir, "apps/web/dist");
  await mkdir(dirname(dest), { recursive: true });
  await cp(join(REPO_ROOT, "apps/web/dist"), dest, { recursive: true });
}

async function stageRootFiles(stageDir) {
  await cp(join(REPO_ROOT, "package.json"), join(stageDir, "package.json"));
  await cp(join(REPO_ROOT, "package-lock.json"), join(stageDir, "package-lock.json"));
  await mkdir(join(stageDir, "config"), { recursive: true });
  await cp(join(REPO_ROOT, "config/portfolio.example.yaml"), join(stageDir, "config/portfolio.example.yaml"));
  await cp(join(REPO_ROOT, ".env.example"), join(stageDir, ".env.example"));

  await mkdir(join(stageDir, "scripts"), { recursive: true });
  for (const script of RUNTIME_SCRIPTS) {
    await cp(join(REPO_ROOT, "scripts", script), join(stageDir, "scripts", script));
  }

  for (const file of BUNDLE_LAUNCHER_FILES) {
    await cp(join(SCRIPT_DIR, "bundle", file), join(stageDir, file));
  }
  await chmod(join(stageDir, "start.sh"), 0o755);
  await chmod(join(stageDir, "install.sh"), 0o755);
}

/**
 * Installs production node_modules into the stage directory using the real workspace lockfile: npm
 * resolves @invest/* as workspace symlinks from the package.json files staged above (no apps/web manifest
 * is present, so its browser-only dependencies are correctly never installed here) and everything else as
 * ordinary hoisted third-party packages. better-sqlite3 is a real (non-optional) dependency of
 * @invest/storage so npm ci installs it too; the bundle relies on node:sqlite instead, so it is removed
 * afterwards (see STORAGE_DRIVER in apps/server/src/app.ts, default "node-sqlite").
 */
async function installProductionDependencies(stageDir) {
  run("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: stageDir });
  await rm(join(stageDir, "node_modules/better-sqlite3"), { recursive: true, force: true });
}

async function proxyDispatcher() {
  // undici already ships as a real dependency of @invest/egress/@invest/server; EnvHttpProxyAgent reads
  // HTTP_PROXY/HTTPS_PROXY/NO_PROXY (any case) the same way the rest of this project's egress layer does,
  // without this script having to hand-roll CONNECT-tunnel proxying. A no-op (direct) when none are set.
  const { EnvHttpProxyAgent } = require("undici");
  return new EnvHttpProxyAgent();
}

async function fetchText(url, dispatcher) {
  const { fetch } = require("undici");
  const response = await fetch(url, { dispatcher });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.text();
}

async function downloadToFile(url, destPath, dispatcher) {
  const { fetch } = require("undici");
  const response = await fetch(url, { dispatcher });
  if (!response.ok || !response.body) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  await mkdir(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function expectedSha256(shasumsText, fileName) {
  const line = shasumsText.split("\n").find((candidate) => candidate.trim().endsWith(`  ${fileName}`));
  if (!line) throw new Error(`${fileName} not listed in SHASUMS256.txt`);
  const hash = line.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`unexpected SHASUMS256.txt line for ${fileName}: ${line}`);
  return hash.toLowerCase();
}

/** Downloads, verifies against nodejs.org's SHASUMS256.txt, and extracts the Node runtime into stageDir/node. */
async function embedNodeRuntime(stageDir, platform, nodeVersion, cacheDir) {
  const asset = NODE_ASSET_BY_PLATFORM[platform];
  const fileName = asset.archive(nodeVersion);
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const dispatcher = await proxyDispatcher();

  log(`fetching SHASUMS256.txt for Node v${nodeVersion}`);
  const shasumsText = await fetchText(`${baseUrl}/SHASUMS256.txt`, dispatcher);
  const expectedHash = expectedSha256(shasumsText, fileName);

  await mkdir(cacheDir, { recursive: true });
  const cachedArchivePath = join(cacheDir, fileName);
  const cached = (await pathExists(cachedArchivePath)) && (await sha256File(cachedArchivePath)) === expectedHash;
  if (cached) {
    log(`using cached ${fileName} (sha256 verified)`);
  } else {
    log(`downloading ${baseUrl}/${fileName}`);
    const startedAtMs = Date.now();
    await downloadToFile(`${baseUrl}/${fileName}`, cachedArchivePath, dispatcher);
    log(`downloaded ${fileName} in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`);
    const actualHash = await sha256File(cachedArchivePath);
    if (actualHash !== expectedHash) {
      await rm(cachedArchivePath, { force: true });
      throw new Error(`sha256 mismatch for ${fileName}: expected ${expectedHash}, got ${actualHash}`);
    }
    log("sha256 verified against SHASUMS256.txt");
  }

  const nodeDir = join(stageDir, "node");
  await rm(nodeDir, { recursive: true, force: true });
  if (asset.kind === "tar") {
    await mkdir(nodeDir, { recursive: true });
    run("tar", ["-xzf", cachedArchivePath, "-C", nodeDir, "--strip-components=1"]);
  } else {
    const extractParent = join(cacheDir, `extract-${platform}-${nodeVersion}`);
    await rm(extractParent, { recursive: true, force: true });
    await mkdir(extractParent, { recursive: true });
    run("unzip", ["-q", cachedArchivePath, "-d", extractParent]);
    const innerName = fileName.replace(/\.zip$/, "");
    await rename(join(extractParent, innerName), nodeDir);
    await rm(extractParent, { recursive: true, force: true });
  }
  log(`embedded Node v${nodeVersion} at ${nodeDir}`);
}

async function packArchive(outDir, stageFolderName, platform, kind) {
  const archiveName = kind === "zip" ? `${stageFolderName}.zip` : `${stageFolderName}.tar.gz`;
  const archivePath = join(outDir, archiveName);
  await rm(archivePath, { force: true });
  if (kind === "zip") {
    run("zip", ["-qr", archivePath, stageFolderName], { cwd: outDir });
  } else {
    run("tar", ["-czf", archivePath, "-C", outDir, stageFolderName]);
  }
  return archivePath;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  log(`platform=${args.platform} node=${args.nodeVersion} out=${args.outDir} skipNode=${args.skipNode}`);

  await ensureServerBuilt();
  const version = await readBundleVersion();
  const stageFolderName = `invest-monitor-${version}-${args.platform}`;
  const stageDir = join(args.outDir, stageFolderName);

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  log("staging workspace packages");
  await stageWorkspacePackages(stageDir);
  log("staging server");
  await stageServer(stageDir);
  log("staging web SPA");
  await stageWeb(stageDir);
  log("staging root files (config example, .env.example, scripts, launchers)");
  await stageRootFiles(stageDir);
  log("installing production dependencies (npm ci --omit=dev --ignore-scripts)");
  await installProductionDependencies(stageDir);

  if (args.skipNode) {
    log("--skip-node set: not embedding a Node runtime; the bundle will look for a system node on PATH");
  } else {
    await embedNodeRuntime(stageDir, args.platform, args.nodeVersion, join(args.outDir, ".node-cache"));
  }

  const kind = NODE_ASSET_BY_PLATFORM[args.platform].kind;
  const archivePath = await packArchive(args.outDir, stageFolderName, args.platform, kind);
  await rm(stageDir, { recursive: true, force: true });

  const { size } = await stat(archivePath);
  log(`done: ${archivePath} (${(size / (1024 * 1024)).toFixed(1)} MiB)`);
}

await main();
