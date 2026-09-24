import { createSocket } from "node:dgram";
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";

let sink: ((line: string) => void) | null = null;
export function serviceLog(event: string, fields: Record<string, unknown> = {}): void {
  if (event === "http.request" && String(fields.path).startsWith("/health/")) return;
  if (sink && event === "http.request") return; // Nginx logs status and duration once.
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n";
  if (sink) sink(line); else process.stdout.write(line);
}

// One buffered file writer and one UDP socket in the existing API process.
// Nginx forwards operational logs here instead of duplicating Docker logs.
export function startServiceLogging(): () => Promise<void> {
  const directory = process.env.LOG_DIR;
  if (!directory) return async () => {};
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stream: WriteStream | null = null, day = "", size = 0, part = 0;
  const rotate = () => {
    const nextDay = new Date().toISOString().slice(0, 10);
    if (stream && nextDay === day && size < 10 * 1024 * 1024) return;
    stream?.end();
    part = nextDay === day ? part + 1 : 0; day = nextDay;
    let path: string;
    do { path = join(directory, `service-${day}-${String(part).padStart(4, "0")}.jsonl`); try { size = statSync(path).size; } catch { size = 0; } if (size >= 10 * 1024 * 1024) part++; } while (size >= 10 * 1024 * 1024);
    stream = createWriteStream(path, { flags: "a", mode: 0o600, highWaterMark: 65536 });
    stream.on("error", () => { sink = null; process.stderr.write("service.log_write_failed\n"); });
    const files = readdirSync(directory).filter(n => /^service-\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/.test(n)).sort().reverse();
    for (const name of files.slice(14)) unlinkSync(join(directory, name));
  };
  sink = line => { rotate(); if (stream!.writableLength > 1024 * 1024) return; size += Buffer.byteLength(line); stream!.write(line); };
  const socket = createSocket("udp4");
  socket.on("message", message => serviceLog("web.access", { message: message.toString("utf8", 0, 4096).replace(/[\r\n]/g, " ") }));
  socket.on("error", () => serviceLog("web.log_socket_failed"));
  socket.bind(Number(process.env.LOG_SYSLOG_PORT ?? 5514), "0.0.0.0"); socket.unref();
  return async () => {
    socket.close(); sink = null;
    if (stream) await new Promise<void>(resolve => stream!.end(resolve));
  };
}
