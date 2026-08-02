/**
 * OKF Wiki localhost server entry.
 *
 * load-env MUST be the first import so process.env is populated before
 * server-config / logging read host, port, and OKF_LOG_*.
 */
import "./load-env.ts";
import { createServer } from "node:http";
import { dispatch } from "./dispatch.ts";
import { getLogger } from "./logging/index.ts";
import { closeOperatorSessions } from "./operator-sessions.ts";
import { allowLan, assertBindPolicy, host, port } from "./server-config.ts";
import { closeWikiRuns } from "./wiki-runs-registry.ts";

assertBindPolicy();

const log = getLogger();

const server = createServer((req, res) => {
  void dispatch(req, res);
});

server.listen(port, host, () => {
  log.info(
    { event: "server.listen", host, port, allowLan },
    `okf-wiki server listening on http://${host}:${port}`,
  );
  if (allowLan) {
    log.info(
      { event: "server.listen", allowLan: true },
      "LAN access enabled (OKF_WIKI_ALLOW_LAN=1); point the Web UI at the same host if needed",
    );
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log.fatal(
      { event: "server.listen", err, port, host },
      `EADDRINUSE: port ${port} is already in use on ${host}`,
    );
  } else {
    log.fatal({ event: "server.listen", err }, "server listen error");
  }
  process.exit(1);
});

// Graceful shutdown: stop accepting connections before exiting.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ event: "server.shutdown", signal }, `received ${signal}, shutting down`);
  await closeOperatorSessions();
  server.close();
  // SSE keep-alive sockets would otherwise hold the process open.
  server.closeAllConnections?.();
  await closeWikiRuns();
  process.exit(0);
}
process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));

process.on("unhandledRejection", (reason) => {
  log.error(
    {
      event: "server.unhandled",
      kind: "unhandledRejection",
      err: reason instanceof Error ? reason : { message: String(reason) },
    },
    "unhandledRejection",
  );
});

process.on("uncaughtException", (error) => {
  log.fatal(
    { event: "server.unhandled", kind: "uncaughtException", err: error },
    "uncaughtException",
  );
  process.exit(1);
});
