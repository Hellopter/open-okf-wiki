# open-okf-wiki (wiki-agent-kit slice)

This branch ships only the portable **wiki-agent-kit** for Claude Code–first source→wiki:

| Path | Role |
|------|------|
| `packages/wiki-agent-kit/` | `ow` CLI, skill, dynamic workflow, tests |
| `docs/research/claude-dynamic-workflow-coding-agent-2026-08.md` | Design notes (packaging, orchestrator context) |

## Quick start

```bash
node packages/wiki-agent-kit/scripts/ow.mjs help
node packages/wiki-agent-kit/scripts/ow.mjs init ./my-ws --lang zh
```

See `packages/wiki-agent-kit/README.md`.
