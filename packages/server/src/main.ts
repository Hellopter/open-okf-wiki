/**
 * OKF Wiki localhost server entry.
 */
import { createServer } from "node:http";
import { dispatch } from "./dispatch.ts";
import { allowLan, assertBindPolicy, host, port } from "./server-config.ts";
import { closeWikiRuns } from "./wiki-runs-registry.ts";

assertBindPolicy();

const server = createServer((req, res) => {
  void dispatch(req, res);
});

server.listen(port, host, () => {
  process.stdout.write(`okf-wiki server listening on http://${host}:${port}\n`);
  if (allowLan) {
    process.stdout.write(
      `LAN access enabled (OKF_WIKI_ALLOW_LAN=1). Use http://<this-machine-ip>:${port} from other devices.\n` +
        `Point the Web UI at the same host: VITE_API_BASE=http://<this-machine-ip>:${port}\n`,
    );
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `EADDRINUSE: port ${port} is already in use on ${host}. ` +
        `Stop the other process or set OKF_WIKI_PORT to a free port.\n`,
    );
  } else {
    process.stderr.write(`server listen error: ${err.stack ?? err.message}\n`);
  }
  process.exit(1);
});

// Graceful shutdown: stop accepting connections before exiting.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`received ${signal}, shutting down…\n`);
  server.close();
  // SSE keep-alive sockets would otherwise hold the process open.
  server.closeAllConnections?.();
  await closeWikiRuns();
  process.exit(0);
}
process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
