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

## Install (no npm publish)

This extension is **not on npm** yet. Install from a local checkout.

### 1. Pi CLI on PATH (required on every machine)

`pi install` only registers the extension. Install the host CLI globally so
`pi` works in any directory:

```bash
npm install -g @mariozechner/pi-coding-agent
# or: npm install -g @earendil-works/pi-coding-agent
cd /tmp && which pi && pi --help
```

### 2a. Project-local (this monorepo only)

Recommended for day-to-day development:

```bash
pnpm install
pnpm -C packages/pi-wiki-agent build
pi install ./packages/pi-wiki-agent --local --approve
pi list --approve
```

### 2b. User-level “local global” (any project)

On another machine, or when you want `/wiki` everywhere without publishing:

```bash
git clone <remote> ~/src/open-okf-wiki
cd ~/src/open-okf-wiki
pnpm install
pnpm -C packages/pi-wiki-agent build
pi install "$(pwd)/packages/pi-wiki-agent"   # no --local → ~/.pi/
pi list
```

The path is referenced in place (not copied); keep the clone and rebuild after
updates. Full detail: [`packages/pi-wiki-agent/README.md`](packages/pi-wiki-agent/README.md#install).

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
