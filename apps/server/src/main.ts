import { fileURLToPath } from "node:url";
import { createRuntime } from "./app.js";
import { serviceLog, startServiceLogging } from "./logger.js";

export { createRuntime } from "./app.js";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const closeLogs = startServiceLogging();
  const runtime = await createRuntime();
  serviceLog("server.started", { port: runtime.port, pid: process.pid });
  const shutdown = async () => {
    await runtime.close();
    await closeLogs();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
