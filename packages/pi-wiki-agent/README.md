# Pi Wiki Agent (`@okf-wiki/pi-wiki-agent`)

Checkpointed, source-grounded **repository Wiki** production for the [Pi](https://pi.dev) coding agent.

Deterministic state (sources, snapshots, checkpoints, plan gate, seal) lives in
`@okf-wiki/wiki-agent-kit`. Orchestration is a **session-native** multi-agent
runtime inside this extension (Pi `createAgentSession` subagents + observation
store). There is **no** dependency on pi-dynamic-workflows.

## Product disambiguation

This package is **not**
[`@zosmaai/pi-llm-wiki`](https://github.com/zosmaai/pi-llm-wiki) (a personal /
LLM-memory vault in the Karpathy LLM Wiki style).

| Product | Purpose | Typical commands |
| --- | --- | --- |
| **@okf-wiki/pi-wiki-agent** (this package) | Repository Wiki from frozen sources + immutable checkpoints | `/wiki`, `/wiki --plan` |
| **@zosmaai/pi-llm-wiki** | Personal knowledge-base wiki for LLM sessions | `/wiki-init`, `/wiki-ingest`, `/wiki-query`, … |

If both packages are installed, slash names can overlap in the palette. Prefer
one product per project, or rely on command descriptions that say **OKF 仓库 Wiki**.

## Quick start

```bash
# From monorepo root
pnpm -C packages/pi-wiki-agent build
pi install ./packages/pi-wiki-agent --local --approve
```

Then open Pi in the project, **trust the project** when prompted, and run:

```text
/wiki help
/wiki
```

Empty `/wiki` opens the live Navigator; it does **not** start a workflow.

## Install

This package is **not published to npm** yet. Install from a local monorepo
checkout (or Git path). You need two things:

1. The **`pi` CLI** on your `PATH` (global install of the host)
2. This **extension** registered with `pi install` (path or Git — no `npm:` needed)

### Prerequisites — install the Pi CLI globally

`pi install …` only registers extensions. It does **not** put the `pi` command
on your `PATH`. Without a global CLI, `pi` works only inside a project’s
`node_modules/.bin` and fails in other directories.

```bash
# Official host (or the earendil-works fork used by this monorepo)
npm install -g @mariozechner/pi-coding-agent
# npm install -g @earendil-works/pi-coding-agent

# Confirm it works outside any project
cd /tmp && which pi && pi --help
```

If `which pi` is empty after install, add npm’s global bin to `PATH`
(`npm bin -g`, often `~/.npm-global/bin` or similar).

### A — Project-local (development)

Use this when you only need the extension inside this monorepo:

```bash
# From monorepo root (after pnpm install)
pnpm -C packages/pi-wiki-agent build
pi install ./packages/pi-wiki-agent --local --approve
```

- `--local` / `-l` writes a path into `.pi/settings.json` (no package copy).
- **Project trust is required** before Pi loads project-local packages:
  - Interactive: approve the trust prompt when opening the project.
  - Headless / RPC: pass `--approve` (or set default project trust).
- After code changes: rebuild, then `/reload` (or restart Pi).

```bash
pnpm -C packages/pi-wiki-agent build
# in Pi: /reload
```

### B — User-level / “local global” (any directory, no npm publish)

Use this on another machine or when you want `/wiki` available in **any**
project without publishing to npm. Omit `--local` so Pi writes user settings
under `~/.pi/` and references the absolute path on disk (no copy).

```bash
# 1) Clone (or copy) this monorepo and install workspace deps
git clone <your-fork-or-remote> ~/src/open-okf-wiki
cd ~/src/open-okf-wiki
pnpm install

# 2) Build dist/ (required — entry is extensions/wiki.ts → ../dist/)
pnpm -C packages/pi-wiki-agent build

# 3) User-level install: absolute path, no -l
pi install "$(pwd)/packages/pi-wiki-agent"

# 4) Confirm
pi list
```

Equivalent forms Pi accepts (still no npm package required):

```bash
pi install /absolute/path/to/open-okf-wiki/packages/pi-wiki-agent
pi install ./packages/pi-wiki-agent          # relative; resolves against cwd / settings
# Git sources also work if the package lives at repo root of that clone:
# pi install git:github.com/org/open-okf-wiki
# pi install https://github.com/org/open-okf-wiki
```

Notes:

- User-level installs are **not** gated by project trust.
- The checkout path must stay on disk; Pi points at it rather than copying.
- Keep `dist/` up to date after pulls: rebuild, then `/reload` or restart Pi.
- Monorepo `workspace:*` deps need a full `pnpm install` at the repo root
  before install; do not install only the package folder in isolation.

| Scope | Command | Settings | Where `/wiki` loads |
| --- | --- | --- | --- |
| Project-local | `pi install ./packages/pi-wiki-agent --local --approve` | `.pi/settings.json` | This project only (when trusted) |
| User-level | `pi install /abs/path/…/pi-wiki-agent` | `~/.pi/` | Any directory |

### If commands are missing

1. Rebuild: `pnpm -C packages/pi-wiki-agent build`
2. Reinstall the package path
3. Trust the project if you used `--local` (`--approve` or TUI trust)
4. `pi list` (add `--approve` when checking project-local installs)
5. Confirm `which pi` points at a global CLI, not only a project `node_modules`
6. Re-run the verify script below

Untrusted projects intentionally **do not** load project-local extensions; that
is expected Pi security behavior, not a broken install.

**`pi: command not found` in other directories** means the CLI was never
installed globally (section Prerequisites), or npm’s global bin is not on
`PATH` — not a failure of `pi install`.

## Verify

```bash
# Unit + integration tests (builds first)
pnpm -C packages/pi-wiki-agent test

# Live Pi RPC: assert /wiki and aliases are registered (from a trusted project cwd)
pnpm -C packages/pi-wiki-agent verify:pi
# or:
node packages/pi-wiki-agent/scripts/verify-pi-install.mjs
```

Manual RPC:

```bash
pi --mode rpc --no-session --approve <<'EOF'
{"id":"1","type":"get_commands"}
EOF
```

Expect: `wiki`, `wiki-help`, `wiki-init`, `wiki-run`, `wiki-source`.

TUI smoke:

1. `/wiki` → bordered phase / agent Navigator (no workflow start)
2. `↑/↓` chooses a phase; `→` enters its agents; `Enter` opens execution output
3. `/wiki init` → create workspace and link project source
4. `/wiki run <focus>` → start orch run
5. `/wiki status --json` → machine-readable workspace and orchestration state

## Commands

Registered names: `/wiki`, `/wiki-help`, `/wiki-init`, `/wiki-run`, `/wiki-source`.

```text
/wiki                         # open the live Navigator (not auto-run)
/wiki help | -h | --help
/wiki status --json           # machine-readable state
/wiki init [--name name] [--lang en|zh] [--force]
/wiki run [focus]
/wiki --plan [focus]
/wiki --write [focus]
/wiki --restart [focus]
/wiki --retry plan|write [focus]
/wiki pause|resume|stop [orch-run-id]
/wiki source list
/wiki source add clone <url> [--id id]
/wiki source add link|path <path> [--id id]
/wiki source remove <id>
```

### Multi-agent observation

Orchestration state is tracked via `SessionWikiOrchestrator`. Live progress:

```text
.wiki-agent/runs/<domainRunId>/orchestration/
  snapshot.json
  events.jsonl
  agents/<agentId>/transcript.jsonl
```

Interactive Pi keeps workflow progress in a compact, display-only status bar.
`/wiki` opens the only observation surface: select a phase, enter its agent
list, then enter an agent to follow its execution stream. `p` pauses or resumes
the run, `x` stops it, and `q` closes the Navigator.

### Semantics

| Input | Behavior |
| --- | --- |
| Empty `/wiki` | Open the live Navigator without starting a workflow |
| `help`, `-h`, `--help` | Print help only |
| Multi-word free text | Run with that focus (`/wiki auth model`) |
| Single unknown token | Error — use `/wiki run <focus>` for one-word focus |
| `status --json` | No auto-init; returns `initialized: false` when the workspace is missing |
| `source list` / pause·resume·stop | No auto-init; missing workspace → ask for `/wiki init` |
| `run` / source add | Auto-init workspace if needed and link `project` source |
| `--plan` | Checkpoint plan; stop before write |
| `--write` | Interactive plan approval, then candidate writing |

Orch run IDs identify orchestration jobs. Domain run IDs come from Bootstrap;
`/wiki status --json` shows both for machine consumers.

### Orchestration path

1. `/wiki run` or `/wiki --plan` → `Bootstrap → Survey → Plan → Gate` (stops for approval)
2. `/wiki --write` → `Write → Verify → Repair* → Validate` (seals candidate)

```text
Bootstrap → Survey (adaptive lanes, grep/find) → Plan → Gate
    → (approve) → Write sources/integration → Verify lenses → Repair* → Validate
```

Control: `/wiki pause` aborts in-flight agents; `/wiki resume` restarts from domain
`prepareRun` startAt. `/wiki stop` cancels the orch run.

In interactive Pi, `/wiki` accepts `↑/↓` or `j/k` to choose a phase, `→` to
enter that phase's agent list, and `Enter` to follow the selected agent's live
execution stream. In the stream, `g/G` jumps to the start/end and `t` refreshes.
`p` pauses/resumes, `x` stops, and `q` or `Esc` closes or goes back. RPC and
print modes use `/wiki status --json`.

Subagents use Pi `createAgentSession` with a sandboxed toolset (read/ls/write/edit/grep/find + host tools). **No bash. No pi-dynamic-workflows.**

## Security model

Workflow subagents receive **no shell tool**. They may use sandboxed `read`,
`ls`, `grep`, `find`, `write`, and `edit` within the active run data plane.
Writes are limited to receipts, plan artifacts, and candidate pages. The core
remains the final authority for checkpoints, source snapshots, plan approval,
and sealing.

## Development

From the monorepo root (install deps first if `node_modules` is missing):

```bash
pnpm install
pnpm -C packages/pi-wiki-agent build
pnpm -C packages/pi-wiki-agent test
pnpm -C packages/pi-wiki-agent typecheck
```

Or from `packages/pi-wiki-agent`:

```bash
pnpm install   # if needed — provides local typescript
pnpm build     # resolves local typescript via scripts/run-tsc.mjs
```

### Troubleshooting: `tsc` is not recognized

That message means a **global** `tsc` was invoked, or dependencies were never
installed. This package does **not** require a global TypeScript install.

```bash
# 1) Install workspace deps (creates packages/pi-wiki-agent/node_modules/typescript)
pnpm install

# 2) Build via package script only
pnpm -C packages/pi-wiki-agent build
```

Do **not** run bare `tsc` in the shell. If `pnpm build` still fails, paste the
full error after `pnpm install` (including the `> node ./scripts/run-tsc.mjs …`
line).

### Troubleshooting: monorepo tests vs Pi host extensions

**A) `pnpm test` cannot find `@earendil-works/pi-ai/compat`**

Peers are listed again under **devDependencies** (same as pi-llm-wiki). From the
monorepo root:

```bash
pnpm install
pnpm -C packages/pi-wiki-agent test
```

Do not put Pi host packages into `dependencies`.

**B) Pi runtime: `…/pi-ai/dist/index.js/compat` (pi-web-access / pi-subagents)**

This is a **host Pi / jiti alias** bug, not OKF wiki-agent. Older Pi maps
`@earendil-works/pi-ai` → `dist/index.js`, then appends `/compat` → invalid path.
Upgrade the host:

```bash
pi update --self
# expect pi --version >= 0.80 (prefer 0.82+)
pi remove npm:pi-web-access
pi remove npm:pi-subagents
pi install npm:pi-web-access
pi install npm:pi-subagents
```

**C) `Unknown option: --approve`**

Your Pi CLI is older than the flag on the main entrypoint. Trust the project
once in interactive Pi, then run `verify:pi` (the script omits `--approve` when
`pi --help` does not list it).

Package layout:

- `extensions/wiki.ts` — Pi package entry (loads `dist/`)
- `src/` — command surface, core adapter, session orch, observation, toolset
- `scripts/verify-pi-install.mjs` — live `get_commands` smoke check
