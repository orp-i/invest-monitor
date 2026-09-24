// Minimal static file server for the built SPA (apps/web/dist). Docker installs keep serving the SPA
// through the Nginx container (docker/nginx.conf.template); this module lets the API process alone serve
// it too, for source and portable-bundle installs that run without a reverse proxy in front. GET/HEAD only,
// path-traversal safe, and mirrors Nginx's security headers and cache policy so behaviour matches across
// distribution modes.
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

export interface StaticWebOptions {
  /** Directory that holds the built SPA (must contain index.html), or null/empty to disable static serving. */
  directory: string | null;
  /** File served for extension-less paths and as the SPA entry point. Defaults to "index.html". */
  indexFile?: string;
}

export interface StaticWeb {
  readonly enabled: boolean;
  readonly directory: string | null;
  /**
   * Serves `request` from the static directory and returns whether it wrote a response. Returns false
   * without writing anything when this instance is disabled, the method is not GET/HEAD, the path starts
   * with /api/ or /health/, or nothing on disk matches — callers should fall through to their own routing
   * (and eventual 404) in that case.
   */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// Same trio Nginx sends via `add_header ... always;` in docker/nginx.conf.template.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

/** First candidate directory that contains index.html. Checked synchronously: this only runs at startup. */
export function resolveWebDistDirectory(env: NodeJS.ProcessEnv, candidates: readonly string[]): string | null {
  void env; // reserved for a future env-driven override; resolution is purely candidate order today
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (statSync(join(candidate, "index.html")).isFile()) return candidate;
    } catch {
      continue; // candidate missing, unreadable, or not a directory: try the next one
    }
  }
  return null;
}

export function createStaticWeb(options: StaticWebOptions): StaticWeb {
  const directory = options.directory && options.directory.length > 0 ? options.directory : null;
  const indexFile = options.indexFile ?? "index.html";
  const enabled = directory !== null;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!enabled || !directory) return false;
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;
    const rawPath = (request.url ?? "/").split(/[?#]/)[0] || "/";
    if (rawPath.startsWith("/api/") || rawPath.startsWith("/health/")) return false;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return send(response, method, 400, "text/plain; charset=utf-8", Buffer.from("Bad Request"), false);
    }

    // Resolve inside `directory` and refuse anything that normalizes outside it (`..`, absolute overrides, etc.).
    const resolved = normalize(join(directory, decodedPath));
    if (resolved !== directory && !resolved.startsWith(directory + sep)) {
      return send(response, method, 403, "text/plain; charset=utf-8", Buffer.from("Forbidden"), false);
    }

    const fileInfo = await stat(resolved).catch(() => null);
    if (fileInfo?.isFile()) {
      const body = await readFile(resolved);
      return send(response, method, 200, contentTypeFor(resolved), body, isImmutableAsset(directory, resolved));
    }
    if (extname(resolved) !== "") return false; // a real, missing asset: let the caller produce its own 404

    // Extension-less path (an SPA route, or "/"): fall back to the entry point, matching Nginx's try_files.
    const indexPath = join(directory, indexFile);
    const indexInfo = await stat(indexPath).catch(() => null);
    if (!indexInfo?.isFile()) return false; // broken install: nothing to fall back to
    const body = await readFile(indexPath);
    return send(response, method, 200, contentTypeFor(indexPath), body, false);
  }

  return { enabled, directory, handle };
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

function isImmutableAsset(directory: string, resolvedPath: string): boolean {
  return resolvedPath.startsWith(join(directory, "assets") + sep);
}

function send(response: ServerResponse, method: string, status: number, contentType: string, body: Buffer, immutable: boolean): true {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  response.end(method === "HEAD" ? undefined : body);
  return true;
}
