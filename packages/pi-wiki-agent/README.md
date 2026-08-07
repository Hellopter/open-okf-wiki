# Pi Wiki Agent

`@okf-wiki/pi-wiki-agent` is the Pi runtime for the checkpointed,
source-grounded repository Wiki workflow. It uses the deterministic
`@okf-wiki/wiki-agent-kit` core for source snapshots, checkpoints, gates, and
candidate validation, and Pi Dynamic Workflows for orchestration, task display,
and pause/resume.

## Local installation

From the repository root, install the local package into Pi:

```bash
pi install ./packages/pi-wiki-agent --local --approve
```

`--local` (or `-l`) writes the package reference to `.pi/settings.json` without
copying the package. Restart Pi or use `/reload` after code changes. The project
must be trusted before Pi loads project-local packages.

## Commands

```text
/wiki [focus]
/wiki --plan [focus]
/wiki --write [focus]
/wiki --restart [focus]
/wiki --retry plan|write [focus]
/wiki init [--name name] [--lang en|zh] [--force]
/wiki status
/wiki pause|resume|stop [pi-workflow-run-id]
/wiki source list
/wiki source add clone <url> [--id id]
/wiki source add link|path <path> [--id id]
/wiki source remove <id>
```

The first non-`init` `/wiki` command initializes the current directory when no
Wiki workspace exists. It does not initialize a workspace merely by starting a
Pi session.

`/wiki --plan` produces and checkpoints a plan, then stops before approval.
`/wiki --write` prompts for explicit approval before it starts candidate
writing.

Pi workflow IDs identify orchestration jobs. The deterministic core returns a
separate domain run ID after Bootstrap; use `/wiki status` to inspect both.

## Security model

Workflow subagents receive no shell tool. Their read access is restricted to the
active run's frozen inputs, sources, method, analysis, and candidates; writes
are limited to receipts, plan artifacts, and candidate pages. The core remains
the final authority for checkpoints, source snapshots, plan approval, and
sealing.
