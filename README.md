# open-okf-wiki (wiki-agent-kit slice)

This branch ships only the portable **wiki-agent-kit** for source-grounded repository-to-Wiki runs.
It uses a deterministic `ow` CLI, a shared Agent Skill, and native Claude Dynamic Workflows:

| Path | Role |
|------|------|
| `packages/wiki-agent-kit/` | `ow` CLI, Skill for `.agents` + `.claude`, Claude workflows, schemas, tests |
| `docs/research/claude-dynamic-workflow-coding-agent-2026-08.md` | Design notes (packaging, orchestrator context) |

## Global CLI Installation

From the repository root, link the development package into pnpm's global bin directory.

### macOS and Linux

```bash
pnpm --dir packages/wiki-agent-kit link --global
command -v ow
ow help
```

If `command -v ow` prints nothing, run `pnpm setup`, open a new shell so its global bin directory
is on `PATH`, and repeat the link command.

### Windows PowerShell

```powershell
pnpm --dir packages/wiki-agent-kit link --global
Get-Command ow
ow help
```

If `Get-Command ow` does not find the command, run `pnpm setup`, close every PowerShell window,
open a new one, and repeat the link command. `pnpm setup` adds pnpm's global bin directory to the
user `PATH`; no administrator shell is required for this user-level installation.

## Quick Start

```bash
ow init ./my-ws --lang zh
ow doctor --workspace ./my-ws
```

See `packages/wiki-agent-kit/README.md`.
