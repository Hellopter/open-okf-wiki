# open-okf-wiki (wiki-agent-kit slice)

Portable **wiki-agent-kit**: deterministic host CLI + frozen method pack + one native Claude workflow.

| Path | Role |
|------|------|
| `packages/wiki-agent-kit/` | `ow` host API, `/wiki` workflow, frozen method pack, handoff schemas, tests |
| `docs/research/claude-dynamic-workflow-coding-agent-2026-08.md` | Design notes |

## Install CLI (dev)

Link the kit package (it owns the `ow` bin). Do **not** run `pnpm link --global` from the monorepo
root — the root package has no binaries and pnpm will warn `has no binaries`.

```bash
pnpm --dir packages/wiki-agent-kit link --global
# equivalent: cd packages/wiki-agent-kit && pnpm link --global
ow help
```

If a previous root link left `open-okf-wiki-wiki-agent-kit` in the global store, remove it with
`pnpm remove -g open-okf-wiki-wiki-agent-kit`, then link the kit again.

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
