# open-okf-wiki (wiki-agent-kit slice)

Portable **wiki-agent-kit**: deterministic host CLI + frozen method pack + one native Claude workflow.

| Path | Role |
|------|------|
| `packages/wiki-agent-kit/` | `ow` host API, `/wiki` workflow, frozen method pack, handoff schemas, tests |
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

Humans use **`/wiki` only** for generation. `ow` is the deterministic host API for workflow agents,
checkpoints, and validation; there is no Skill-to-Workflow handoff. Existing workspaces must be
reinitialized as `workspace.yaml` v2.

Details: `packages/wiki-agent-kit/README.md`.
