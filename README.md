# OKF Wiki

OKF Wiki turns a pinned **Repository Snapshot Set** into a source-grounded Markdown **Wiki**.

The product is a **local Web UI**, a **localhost Node server**, and a **Pi agent harness**, with a trusted **Run Boundary** in TypeScript (`@okf-wiki/core`) and a durable **WikiRuns** control plane (`@okf-wiki/workflow`). The operator configures a **Workspace** of local Git checkouts (link existing paths or clone into the workspace). The agent follows a versioned Producer Skill; each Attempt writes pages into isolated Staging. The Run Boundary freezes snapshots and the Skill, enforces path policy, validates Markdown mechanically, and publishes the whole Wiki atomically.

The **Agent Workspace** (`/w/:id`) is the only operator surface. It projects two independent authorities: the **Operator Session** (Pi JSONL / genuine Pi events) and **WikiRuns** (durable Run commands, gates, and Run SSE). The real Pi `wiki_produce` tool dispatches `StartRun` and returns a receipt; it does **not** own the whole Run or await gates ([ADR 0035](docs/adr/0035-durable-wikiruns-control-plane.md)).

| Doc | Purpose |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Domain vocabulary |
| [docs/adr/](docs/adr/) | Architecture decisions ([index](docs/adr/README.md)) |
| [packages/README.md](packages/README.md) | Monorepo package map |
| [ADR 0035](docs/adr/0035-durable-wikiruns-control-plane.md) | **Current Run control:** durable WikiRuns, typed commands/gates/events, `wiki_produce` → `StartRun` receipt, separate Run SSE |
| [ADR 0032](docs/adr/0032-pi-tool-owned-wiki-runs.md) | Pi Session authority and Agent Workspace; whole-Run tool ownership superseded by 0035 |
| [ADR 0021](docs/adr/0021-retire-python-primary-path.md) | Python primary path retired |
| [ADR 0022](docs/adr/0022-source-clone-into-workspace.md) | Operator-initiated source clone |
| [ADR 0031](docs/adr/0031-unidirectional-framework-first-operator-surface.md) | Unidirectional package boundaries and framework-first projection |
| [ADR 0030](docs/adr/0030-pi-agent-harness-for-semantic-workflow.md) | Pi runtime and tool policy; shell clauses superseded by ADR 0032 |

Historical ADRs 0020 / 0024 / 0025 / 0027 describe the former Mastra + AI SDK stack; framework clauses are superseded by **0030**.

## Requirements

| Need | Detail |
|---|---|
| **Node.js** | `>=22.23.0 <23` (`engines` in root `package.json`). CI pins **`22.23.x`** for `node:sqlite` (WikiRuns `workflow.sqlite`, ADR 0035) |
| **pnpm** | Workspace package manager ([pnpm.io](https://pnpm.io/); pin in `packageManager`) |
| **Git** | Local checkouts; product may **clone** when the operator asks (never silently in the Semantic Workflow) |
| **pre-commit** (optional) | [pre-commit.com](https://pre-commit.com/) for staged hygiene + ESLint |

Supported platforms follow the portable filesystem policy ([ADR 0017](docs/adr/0017-portable-host-filesystem-and-directory-rename-publication.md); Run Boundary language in [ADR 0019](docs/adr/0019-prefer-run-boundary-over-host.md)): absolute non-overlapping roots, exclusive create, same-volume directory rename for publication.

## Install

```bash
pnpm install
# optional quality hooks
pre-commit install
```

Copy [`.env.example`](.env.example) to an untracked `.env` (or export vars in the shell). Secrets never go in `workspace.json`.

| Package | Role |
|---|---|
| `@okf-wiki/web` | Operator Web UI (Vite + React + shadcn Agent Workspace) |
| `@okf-wiki/server` | Localhost HTTP API + Pi session SSE + WikiRuns command/Run SSE routes |
| `@okf-wiki/agent` | Pi sessions, real `wiki_produce` → `StartRun` receipt, Semantic Workflow (no Mastra/AI SDK) |
| `@okf-wiki/workflow` | Durable WikiRuns control plane (`workflow.sqlite`, commands, gates, events) |
| `@okf-wiki/core` | Run Boundary (git probe, path policy, publish, stores) |
| `@okf-wiki/contract` | Shared Zod schemas + agent protocol + `okf.wiki-runs/v1` |
| `@okf-wiki/skill` | Bundled Producer Skill assets |

**Architecture guard:** `pnpm check:architecture` rejects retired packages/protocols and forbidden product dependencies (`@mastra/*`, `ai`, `@ai-sdk/*`).

## Quick start

```bash
# 1) Install
pnpm install

# 2) Credentials (process env or untracked .env)
export OPENAI_API_KEY=sk-...
# Optional OpenAI-compatible gateway (base usually ends with /v1):
# export OPENAI_BASE_URL=https://openrouter.ai/api/v1

# 3) API + Web (hot reload)
pnpm dev
# → API  http://127.0.0.1:8787
# → UI   http://127.0.0.1:5173  (proxies /api → server)
```

**Default is live** produce (real Pi agent + model). Configure one or more model profiles in **Settings** (base URL, API key, max context; OpenAI-compatible gateways only), or set `OPENAI_API_KEY` (and optional `OPENAI_BASE_URL`) as env fallback. Workspace `limits.contextTargetTokens` drives Pi compaction (default 85% of profile max context). Producer / home / workspace skills load into the Pi session. Missing credentials fail with a clear error.

For **no-LLM pipeline smoke** only (tests, e2e, path/publish checks), set `OKF_WIKI_AGENT_MODE=fixture`. That is not the normal operator path.

`pnpm dev` runs an **ordered** watch stack (`scripts/dev-stack.mjs`, no Turbo):

1. Free stale API/Vite ports if needed  
2. **One** `tsc -b tsconfig.libs.json` (contract → core → agent), then `--watch`  
3. Start API (`node --watch`)  
4. Wait for `GET /api/health`  
5. Start Vite  

That keeps the process count at **3** (libs watch + server + web) instead of five
parallel package watches, avoids browser 502 before the API listens, and clears
orphaned `5173`/`8787` listeners from a previous crash.

| Command | What starts |
|---|---|
| `pnpm dev` / `dev:full` | libs watch + server + Vite (after health) |
| `pnpm dev:server` | libs watch + server only |
| `pnpm dev:web` | Vite only (contract sources via Vite alias) |
| `pnpm build:libs` | one-shot `tsc -b tsconfig.libs.json` |

| Process (full profile) | Hot reload |
|---|---|
| `@okf-wiki/web` | Vite HMR; `@okf-wiki/contract` resolves to **src** in dev |
| `@okf-wiki/server` | `node --watch` on server src; imports **lib dist** |
| libs | single `tsc -b --watch` → `packages/{contract,core,agent}/dist` |

Env: `OKF_DEV_KILL_PORTS=0` refuses busy ports (default frees them);
`OKF_DEV_PROFILE=server|web|full` overrides the profile. Escape hatch without
health gate: `pnpm dev:stack:parallel`.

### Operator flow (browser)

1. Open **Workspaces** → create a workspace with an **absolute** `rootPath`.
2. **Settings** → configure model catalog endpoints if needed (secrets stay machine-local / env).
3. Open **Agent Workspace** (`/w/:id`) — session list, transcript, sources/wiki/plan/run panels.
4. Ask the Operator Agent to produce or refresh the Wiki; it calls `wiki_produce` (returns a `StartRun` receipt). Approve plan/publication gates on the durable Run surface when shown. **Stop Run** cancels the WikiRun; Session abort only stops the current Operator turn (dual-surface chrome).
5. Browse published Markdown under the Wiki panel or `/workspaces/:id/wiki`.

Legacy multi-tab Session chat (AI SDK `useChat`) is **removed**. Old `.okf-wiki/sessions/*.json` files are not migrated — wipe if present and use Pi sessions under `.okf-wiki/pi-sessions/`.

### Provider and server environment

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | API key for OpenAI / compatible Chat Completions |
| `OPENAI_BASE_URL` | Optional API root (usually ends with `/v1`) |
| `OKF_WIKI_AGENT_MODE` | Optional `fixture` for no-LLM smoke only; default is live |
| `OKF_WIKI_HOST` / `OKF_WIKI_PORT` | API bind (default `127.0.0.1:8787`) |
| `OKF_WIKI_HOME` | Machine-local product home (model catalog, app index) — not skills |
| `OKF_WIKI_ALLOW_LAN` | Opt-in LAN bind / CORS for private origins |
| `VITE_API_BASE` | Only if UI and API are **not** same-origin |

Model identity stays provider-prefixed (for example `openai:<served-model-name>`) even on third-party gateways. Full template: [`.env.example`](.env.example).

## Scripts and quality gates

| Command | What it does | When |
|---|---|---|
| `pnpm dev` | Ordered stack: libs `tsc -b -w` + API + Vite | Day-to-day development |
| `pnpm build` | Build all packages | Release / packaging |
| `pnpm typecheck` | Root solution `tsc -b` (project references) | Local before PR; **CI** |
| `pnpm lint` / `pnpm lint:fix` | ESLint flat config (`eslint.config.mjs`) | Local; staged pre-commit; **CI** |
| `pnpm format` / `pnpm format:check` | Biome format (+ import assist); lint stays ESLint | Local; staged pre-commit; **CI** |
| `pnpm check` | `typecheck` + `lint` + `format:check` + architecture guard | Convenient full static check |
| `pnpm check:architecture` | Reject retired packages, protocols, routes, and dependency edges | Local / **CI**; part of `check` |
| `pnpm test` | Package unit tests (`node:test` where present) | Local; **CI** |
| `pnpm test:e2e` | Playwright Web e2e (`@okf-wiki/web`) | Local when touching UI/API; **CI job** |

```bash
pnpm install
pnpm test
pnpm check          # typecheck + eslint + biome format + architecture guard
```

### Pre-commit (optional, recommended)

```bash
pre-commit install
pre-commit run -a   # full tree
```

Hooks stay **fast**: trailing whitespace / YAML hygiene + Biome format + ESLint on **staged** files only. Full typecheck and Playwright stay in **CI** so commits are not blocked by multi-minute runs.

Config: [`.pre-commit-config.yaml`](.pre-commit-config.yaml) · ESLint: [`eslint.config.mjs`](eslint.config.mjs) · Biome: [`biome.json`](biome.json).

### End-to-end (Playwright)

```bash
pnpm --filter @okf-wiki/web exec playwright install chromium
pnpm test:e2e
```

Agent Workspace smoke lives under `packages/web/e2e/agent-workspace.spec.ts`. Specs live under `packages/web/e2e/`. Playwright is not a pre-commit gate.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml):

1. **typescript** — unit tests (contract / core / agent) + `pnpm check`
2. **web-e2e** — Playwright Chromium against the local dev stack

## Manual verification

### Same machine (default)

```bash
pnpm dev
# → UI  http://127.0.0.1:5173
# → API http://127.0.0.1:8787
```

Open `/workspaces`, create a workspace, land on `/w/<id>` Agent Workspace.

## License

See repository license file when present.
