# @okf-wiki/web

Vite + React operator UI for OKF Wiki. It talks to `@okf-wiki/server` over local HTTP/SSE; among product packages it depends only on `@okf-wiki/contract`, never on Agent or Core implementation modules.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm --filter @okf-wiki/web dev` | Start Vite; `/api` proxies to `127.0.0.1:8787` |
| `pnpm --filter @okf-wiki/web build` | Typecheck and build production assets |
| `pnpm --filter @okf-wiki/web typecheck` | Typecheck without emitting |
| `pnpm --filter @okf-wiki/web test` | Run projector/unit tests |
| `pnpm --filter @okf-wiki/web test:e2e` | Run Playwright end to end |

## Operator surface

The Agent Workspace (`/w/:id`) is the only operate surface. Sources, Published Wiki, and Workspace settings remain supporting read/configuration pages; there is no independent Run page or Run command UI beyond the in-transcript Run inspector.

The workspace uses two projection paths:

1. **Operator Session SSE** — current server snapshot, then genuine parent Pi `AgentSession` events for the transcript.
2. **WikiRuns SSE** (`useWikiRun`) — after `wiki_produce` returns `accepted+runId`, the tool card and Run inspector subscribe to `GET …/runs/:runId` + EventSource `…/runs/:runId/events` (Last-Event-ID on reconnect; heartbeats ignored). Full snapshots replace projection by event id.

Plan/publication gates and failed-node retry/rerun dispatch durable WikiRuns commands (`ResolveGate`, `RetryFailedNode`, `RerunNode`). Do **not** use Session-owned gate resume.

UI primitives live under `src/components/ui/` (shadcn/Base UI). Workspace pages reuse `WorkspaceShell` and `WorkspaceSubnav`; destructive actions use `ConfirmDialog`, and toasts use `sonner`.

## End-to-end tests

Playwright specs live in `e2e/`. `scripts/e2e-dev.mjs` builds the libraries, starts a server with an isolated `OKF_WIKI_HOME`, and starts Vite. Workers remain fixed at one until product indexes support concurrent writers.

```bash
pnpm exec playwright install chromium
pnpm --filter @okf-wiki/web test:e2e
```

Keep existing `data-testid` values on the interactive element that a spec targets. Shared setup helpers live in `e2e/helpers.ts`; generated Playwright artifacts are ignored.
