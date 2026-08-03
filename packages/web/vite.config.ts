import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8787";
const contractDir = path.resolve(__dirname, "../contract/src");

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Dev: follow contract TypeScript sources (HMR) instead of waiting on tsc dist.
      // Subpath exports map to barrel entry files (Epic A hard-cut).
      "@okf-wiki/contract/session": path.join(contractDir, "session.ts"),
      "@okf-wiki/contract/wiki-runs": path.join(contractDir, "wiki-runs-api.ts"),
      "@okf-wiki/contract/coverage": path.join(contractDir, "coverage.ts"),
      "@okf-wiki/contract/stream-server": path.join(contractDir, "stream-server.ts"),
      "@okf-wiki/contract/workspace": path.join(contractDir, "workspace-api.ts"),
      "@okf-wiki/contract/pi-attempt": path.join(contractDir, "pi-attempt.ts"),
      // Root: errors-only (no business types).
      "@okf-wiki/contract": path.join(contractDir, "index.ts"),
    },
    // Vite runtime supports extensionAlias; @types/vite may lag behind.
    ...({
      extensionAlias: {
        ".js": [".ts", ".js"],
      },
    } as Record<string, unknown>),
  },
  optimizeDeps: {
    // Keep workspace contract out of the dep optimizer so source edits invalidate cleanly.
    exclude: ["@okf-wiki/contract"],
  },
  server: {
    // Listen on all interfaces so http://<any-ip>:5173 works on LAN.
    // Restrict with VITE_DEV_HOST=127.0.0.1 if needed.
    host: process.env.VITE_DEV_HOST ?? "0.0.0.0",
    port: Number(process.env.VITE_DEV_PORT ?? "5173"),
    strictPort: true,
    // Browser always talks to the Vite origin (/api/...). Proxy forwards to
    // the Node server on this machine — no hardcoded LAN IP in the client.
    // Imported contract sources (alias) are part of the module graph and watched.
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("error", (err, _req, res) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[vite proxy] ${apiProxyTarget} unavailable: ${message}`);
            if (
              res &&
              "writeHead" in res &&
              typeof res.writeHead === "function" &&
              !res.headersSent
            ) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "api_unavailable",
                  message: `API proxy target ${apiProxyTarget} is down. Is pnpm dev / dev:server running?`,
                }),
              );
            }
          });
        },
      },
    },
  },
});
