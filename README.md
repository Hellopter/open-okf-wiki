# open-okf-wiki (wiki-agent-kit slice)

Portable **wiki-agent-kit**: agent-host CLI + method skill + Claude workflows, with a single human entry.

| Path | Role |
|------|------|
| `packages/wiki-agent-kit/` | `ow` agent API, `/wiki` entry skill, method skill, workflows, tests |
| `docs/research/claude-dynamic-workflow-coding-agent-2026-08.md` | Design notes |

## Install CLI (dev)

```bash
pnpm --dir packages/wiki-agent-kit link --global
ow help
```

## Quick start

```bash
ow init ./my-ws --lang zh --path /path/to/repo --id app
cd my-ws
claude
# /wiki core architecture
```

Humans use **`/wiki` only** for generation. `ow` is the deterministic host API for agents and recovery.

Details: `packages/wiki-agent-kit/README.md`.
