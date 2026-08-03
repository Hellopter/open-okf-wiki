# Packages

Primary product implementation for OKF Wiki. Current stack: **Pi + `packages/*`** — [0041](../docs/adr/0041-contract-subpaths-and-agent-port-thinning.md) (contract subpaths / port thinning), [0036](../docs/adr/0036-semantic-artifact-plane-and-execution-plan.md) (semantic execution contract), [0035](../docs/adr/0035-durable-wikiruns-control-plane.md) (durable Run control), [0033](../docs/adr/0033-run-graph-and-agent-layering.md) (package layering), [0030](../docs/adr/0030-pi-agent-harness-for-semantic-workflow.md) (Pi harness), [0021](../docs/adr/0021-retire-python-primary-path.md) (Python primary path removed), and [0029](../docs/adr/0029-architecture-cleanup-no-compat.md) (hard-cut cleanup). Full index: [docs/adr/README.md](../docs/adr/README.md). Do not implement via Mastra, Vercel AI SDK, Logfire product path, or Python harness.

| Package | Role |
|---------|------|
| `@okf-wiki/contract` | Shared schemas + pure helpers (**subpath exports only** for business types; root = errors) |
| `@okf-wiki/core` | Run Boundary: snapshots, citation-target, pure validate → MechanicalIssue, publication/{digest,lock,materialize,apply} (no Pi) |
| `@okf-wiki/agent` | Pi Attempt runtime; thin tools (`wiki_produce` / `wiki_repair` / submit_*); deep `commitPlanDraft` + path-first review; **AgentRunner port only** (no SpecStore, no produce/) |
| `@okf-wiki/workflow` | Durable WikiRuns: owner + **WikiRunsControl** (CAS/control ctx), scheduler, gates, effects; attempt-finish still concentrating |
| `@okf-wiki/server` | Localhost HTTP: WikiRuns commands, **sse/** framing+subscribe, operator sessions, workspace config |
| `@okf-wiki/web` | Operator Web UI: Session transcript + Run Workspace; **URL selection**; no stream-server imports |
| `@okf-wiki/skill` | Embedded Producer Skill |

### `@okf-wiki/contract` subpaths (Epic A hard-cut)

Import **business types** from a subpath. The package root exports **error codes only**.

| Subpath | Audience | Contents |
|---------|----------|----------|
| `@okf-wiki/contract/session` | web, server | Session SSE DTOs, agent commands, session usage |
| `@okf-wiki/contract/wiki-runs` | web, server, workflow, agent | WikiRuns commands/snapshot, Spec, evaluation, node-contract, **observe helpers** |
| `@okf-wiki/contract/coverage` | agent, workflow, core, server | CoverageUnit / assertCoverage |
| `@okf-wiki/contract/stream-server` | **server only** (+ contract tests) | `reducePiEvent`, `AgentMessage`, Pi stream reduce |
| `@okf-wiki/contract/workspace` | server, core, web settings | WorkspaceConfig, intake, provider, skill, primitives |
| `@okf-wiki/contract/pi-attempt` | agent, workflow | PiAttemptOutcome / input descriptors |
| `@okf-wiki/contract` (root) | rare | `WORKSPACE_INTAKE_ERROR_CODES` / provider store error codes only |

Web must **not** import `stream-server`. Architecture guard: `pnpm check:architecture`.

The single architecture guard, `pnpm check:architecture`, protects these dependency arrows and rejects retired packages, operator surfaces, protocols, and dependencies.
