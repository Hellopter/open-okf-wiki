# Pi Wiki Agent (`@okf-wiki/pi-wiki-agent`)

Checkpointed, source-grounded **repository Wiki** production for the [Pi](https://pi.dev) coding agent.

Deterministic state (sources, snapshots, checkpoints, plan gate, seal) lives in
`@okf-wiki/wiki-agent-kit`. Orchestration (background runs, task panel,
pause/resume) uses [Pi Dynamic Workflows](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows).

## Product disambiguation

This package is **not**
[`@zosmaai/pi-llm-wiki`](https://github.com/zosmaai/pi-llm-wiki) (a personal /
LLM-memory vault in the Karpathy LLM Wiki style).

| Product | Purpose | Typical commands |
| --- | --- | --- |
| **@okf-wiki/pi-wiki-agent** (this package) | Repository Wiki from frozen sources + immutable checkpoints | `/wiki`, `/wiki-status`, `/wiki --plan` |
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
/wiki status
```

Empty `/wiki` shows help; it does **not** start a workflow.

## Install

### A — Project-local (development)

```bash
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

### B — User / absolute path

```bash
pnpm -C packages/pi-wiki-agent build
pi install /absolute/path/to/open-okf-wiki/packages/pi-wiki-agent
```

User-level installs are not gated by project trust, but `dist/` must still be
built: the entry is `extensions/wiki.ts` → `../dist/extension.js`.

### If commands are missing

1. Rebuild: `pnpm -C packages/pi-wiki-agent build`
2. Reinstall the package path
3. Trust the project (`--approve` or TUI trust)
4. `pi list --approve` — package should appear
5. Re-run the verify script below

Untrusted projects intentionally **do not** load project-local extensions; that
is expected Pi security behavior, not a broken install.

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

Expect: `wiki`, `wiki-help`, `wiki-status`, `wiki-init`, `wiki-run`, `wiki-source`.

TUI smoke:

1. `/wiki` → multi-line help (no workflow start)
2. `/wiki-status` → workspace / sources / domain run + Pi workflow ids
3. `/wiki init` → create workspace and link project source
4. `/wiki run <focus>` or multi-word `/wiki repository architecture` → start run

## Commands

Registered names: `/wiki`, `/wiki-help`, `/wiki-status`, `/wiki-init`,
`/wiki-run`, `/wiki-source` (aliases share one executor).

```text
/wiki                         # help (not auto-run)
/wiki help | -h | --help
/wiki status
/wiki init [--name name] [--lang en|zh] [--force]
/wiki run [focus]
/wiki --plan [focus]
/wiki --write [focus]
/wiki --restart [focus]
/wiki --retry plan|write [focus]
/wiki pause|resume|stop [pi-workflow-run-id]
/wiki source list
/wiki source add clone <url> [--id id]
/wiki source add link|path <path> [--id id]
/wiki source remove <id>
```

### Semantics

| Input | Behavior |
| --- | --- |
| Empty `/wiki`, `help`, `-h`, `--help` | Print help only |
| Multi-word free text | Run with that focus (`/wiki auth model`) |
| Single unknown token | Error — use `/wiki run <focus>` for one-word focus |
| `status` / `source list` / pause·resume·stop | No auto-init; missing workspace → ask for `/wiki init` |
| `run` / source add | Auto-init workspace if needed and link `project` source |
| `--plan` | Checkpoint plan; stop before write |
| `--write` | Interactive plan approval, then candidate writing |

Pi workflow IDs identify orchestration jobs. The core returns a separate
**domain run ID** after Bootstrap; `/wiki status` shows both.

## Security model

Workflow subagents receive **no shell tool**. Reads are limited to the active
run’s frozen inputs, sources, method, analysis, and candidates. Writes are
limited to receipts, plan artifacts, and candidate pages. The core remains the
final authority for checkpoints, source snapshots, plan approval, and sealing.

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

### Troubleshooting: `Cannot find module '@earendil-works/pi-ai/compat'`

Pi host packages (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) are
**peerDependencies** (provided by Pi at runtime) and the same packages are
listed again under **devDependencies** so local `pnpm test` can resolve them
(same pattern as `pi-llm-wiki` / `pi-dynamic-workflows`).

```bash
# From monorepo root — installs peer packages via devDependencies
pnpm install
pnpm -C packages/pi-wiki-agent test
```

Do not move those packages into `dependencies` (would conflict with the Pi host).
Do not rely on pnpm hoisting workarounds.

Package layout:

- `extensions/wiki.ts` — Pi package entry (loads `dist/`)
- `src/` — command surface, core adapter, workflow script, toolset
- `scripts/verify-pi-install.mjs` — live `get_commands` smoke check
