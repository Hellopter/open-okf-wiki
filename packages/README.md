# Packages

Primary product implementation for OKF Wiki. Current stack: **Pi + `packages/*`** — [0036](../docs/adr/0036-semantic-artifact-plane-and-execution-plan.md) (semantic execution contract), [0035](../docs/adr/0035-durable-wikiruns-control-plane.md) (durable Run control), [0033](../docs/adr/0033-run-graph-and-agent-layering.md) (package layering), [0030](../docs/adr/0030-pi-agent-harness-for-semantic-workflow.md) (Pi harness), [0021](../docs/adr/0021-retire-python-primary-path.md) (Python primary path removed), and [0029](../docs/adr/0029-architecture-cleanup-no-compat.md) (hard-cut cleanup). Full index: [docs/adr/README.md](../docs/adr/README.md). Do not implement via Mastra, Vercel AI SDK, Logfire product path, or Python harness.

| Package | Role |
|---------|------|
| `@okf-wiki/contract` | Shared schemas (workspace, run, agent protocol) |
| `@okf-wiki/core` | Run Boundary: immutable snapshots, validation, publication (no Pi) |
| `@okf-wiki/agent` | Pi Attempt runtime adapters and `wiki_produce` / `wiki_repair` tools |
| `@okf-wiki/workflow` | Durable WikiRuns control implementation |
| `@okf-wiki/server` | Localhost HTTP: WikiRuns commands, projections/SSE, and workspace configuration |
| `@okf-wiki/web` | Operator Web UI (Vite + React + shadcn Run Workspace) |
| `@okf-wiki/skill` | Embedded Producer Skill |

The single architecture guard, `pnpm check:architecture`, protects these dependency arrows and rejects retired packages, operator surfaces, protocols, and dependencies.
