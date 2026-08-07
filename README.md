# open-okf-wiki

`open-okf-wiki` is a Pi extension for producing repository wikis through a
checkpointed, source-grounded workflow. The domain state, frozen source
snapshots, review gates, and candidate sealing live under `.wiki-agent` in the
selected workspace.

| Path | Role |
| --- | --- |
| `packages/wiki-agent-kit/` | Framework-neutral deterministic Wiki core, method pack, schemas, and tests |
| `packages/pi-wiki-agent/` | Pi extension, commands, constrained workflow tools, and workflow integration |
| `docs/research/` | Reference-project analysis and design notes |

## Local development install

Pi can install an extension directly from this repository. The project-local
installation is the recommended development path:

```bash
pnpm install
pi install ./packages/pi-wiki-agent --local --approve
pi list --approve
```

Start Pi in the repository to document, then run `/wiki`. The first user
invocation initializes the current directory as a Wiki workspace when needed.
Use `/wiki init --lang zh` to initialize explicitly, or `/wiki source add path
<directory>` and `/wiki source add clone <url>` to add sources.

## Commands

`/wiki` starts or resumes the complete production workflow. `/wiki --plan`
produces and checkpoints the plan, then stops before approval. `/wiki --write`
prompts for explicit approval and then continues a write-ready run.
Use `/wiki status`, `/wiki pause`, `/wiki resume`, and `/wiki stop` to control
background work. The extension keeps Pi workflow execution state separate from
the authoritative `.wiki-agent` domain run state.

Run the verification suite with:

```bash
pnpm test
```
