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

The linked Operator Session and Run Workspace (`/w/:id`) is the operator surface. Sources, Published Wiki, and Workspace settings remain supporting read/configuration pages. A Session can invoke `wiki_produce` repeatedly; its receipts link to durable Run detail and review views.

### URL selection (sole authority)

Workbench panel and ids come only from the query string (ADR 0039) — there is no independent React `surface` store:

| Params | Panel |
| --- | --- |
| (no `run`) | Conversation (`SessionTranscript`) |
| `?run=` | Run canvas |
| `?run=&attempt=` or `?run=&node=` | Attempt / node observation |

`session`, `stage` pin Session and graph stage without changing the Session/Run domain split. Stopping a Session aborts the Pi turn only; Run stop/pause/retry use WikiRuns commands.

### Projection paths

1. **Session SSE** — redacted Session snapshot/stream (`@okf-wiki/contract/session`); user-visible text, tool lifecycle, bounded `wiki_produce` receipts. Live UI uses `SessionTranscript`, not AgentMessage/`AssistantTurn`.
2. **WikiRuns index SSE** — `GET …/runs/index` then EventSource `…/runs/index/events`.
3. **WikiRuns detail SSE** — `GET …/runs/:runId` then EventSource `…/runs/:runId/events` (Last-Event-ID on reconnect). Pure reducers live in `run-workspace/observation-state.ts`; `useRunObservation` is transport-only.

Web must not import `@okf-wiki/contract/stream-server` (AgentMessage / `reducePiEvent` / `applyStreamPatch` are server-only). Session and Run connection indicators are separate badges — domains are never merged into one status.

Plan/publication gates and failed-node retry/rerun dispatch durable WikiRuns commands (`ResolveGate`, `RetryFailedNode`, `RerunNode`). Session state never replaces Run state, and Session events never synthesize Run state.

UI primitives live under `src/components/ui/` (shadcn/Base UI). Workspace pages reuse `WorkspaceShell` and `WorkspaceSubnav`; destructive actions use `ConfirmDialog`, and toasts use `sonner`.

## End-to-end tests

Playwright specs live in `e2e/`. `scripts/e2e-dev.mjs` builds the libraries, starts a server with an isolated `OKF_WIKI_HOME`, and starts Vite. Workers remain fixed at one until product indexes support concurrent writers.

```bash
pnpm exec playwright install chromium
pnpm --filter @okf-wiki/web test:e2e
```

Keep existing `data-testid` values on the interactive element that a spec targets. Shared setup helpers live in `e2e/helpers.ts`; generated Playwright artifacts are ignored.
