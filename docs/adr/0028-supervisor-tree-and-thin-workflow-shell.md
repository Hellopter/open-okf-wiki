# Thin Workflow shell + dynamic Supervisor tree for Wiki generation

**Status:** accepted (shell implementation historical — see status note)  
**Date:** 2026-07-22  
**Related:** ADR 0014 (planning/subagents), ADR 0025 (wiki-run workflow), ADR 0026/0027 (Session stream)  
**Supersedes (partial):** optional `adaptive`/`reviewer` flags; fixed-stage research/write foreach as the primary topology; open-loop post-write review  
**Shell path:** Mastra workflow → Pi WikiRunShell ([0030](0030-pi-agent-harness-for-semantic-workflow.md)) → tool-owned run ([0032](0032-pi-tool-owned-wiki-runs.md)) → **WikiRuns durable control** ([0035](0035-durable-wikiruns-control-plane.md))

> **Status note:** Supervisor **topology intent** (plan → research Domain/Leaf → write → review council → repair → publish) remains. ~~Thin Workflow shell / WikiRunShell as Run owner~~ is **historical**. Current durable shell is WikiRuns definition DAG + thin Pi tools (StartRun receipt).

## Context

The product had:

1. A **linear** Mastra workflow (`plan-gate → write → publish-gate`) with a single Root agent stream.
2. Optional Domain/Leaf/Reviewer behind `workspace.adaptive` / `workspace.reviewer` (default off).
3. A thin `{ summary, pages[{path,purpose}] }` plan and review that wrote receipts but did not fail the run.

Cursor’s 2026 agent-swarm results favor a **dynamic Planner–Worker tree** over rigid stage machines or flat self-coordination. Mastra 1.x recommends **Supervisor agents** for open-ended multi-agent work and **Workflows** when the product path is known (HITL, validate, publish).

## Decision

1. **Two-layer control**
   - **Layer A — thin Workflow shell:** `plan-gate → produce → hard-validate → publish-gate`.
   - **Layer B — Supervisor produce:** Root planner with always-on Domain/Leaf researchers, living **WikiRunSpec**, Host review council, repair rounds, fail-closed publishability scoring.

2. **WikiRunSpec** replaces the thin page list: domains, page questions, acceptance, changelog. Persisted under run analysis scratch as `spec.json`. Root may replan via `read_spec` / `write_spec`.

3. **No adaptive/reviewer toggles.** Small repos use a short tree; large repos fan out under Host budgets (`workspace.orchestration` + delegation hooks).

4. **Role models** (`workspace.roleModels`): planner / worker / writer / reviewers for hybrid economics. Omitted roles fall back to `workspace.model`.

5. **Review is Host-owned:** `runReviewCouncil` → `defects.json` → repair loop → `evaluateWikiPublishable`. Blocking defects prevent publish. Mechanical `validateWikiTree` remains in produce and hard-validate.

6. **Delegation hooks** enforce max domain/leaf fan-out, inject scope-only prompts, and filter child message history.

## Consequences

- Session plan UI shows Spec (domains + pages + questions), not only path bullets.
- Fixture mode writes clean `defects.json` so hard-validate passes without an LLM.
- ADR 0010 “DynamicWorkflow-only leaf layer” is historical; dynamic fan-out is Supervisor + hooks.
- **Review council size** defaults to **1** (set `orchestration.reviewCouncilSize` or `roleModels.reviewers` for multi-lens review).
- Session timeline (AI Elements):
  - **ChainOfThought** phase strip from `data-progress.steps`
  - **Queue** for Spec pages (`data-plan-progress`)
  - **Sources** from `data-sources-index` (repo-relative paths)
  - **Task** subagent cards + `data-agent-span` from delegation hooks
  - **`data-defects`** after each council round
  - **Checkpoint** visual separators only (no message restore / run rollback)
- Produce uses **soft** `onIterationComplete` write nudges only — **not** `isTaskComplete` score-0 forced loops.
- ~~Optional `OKF_WIKI_DURABLE_PRODUCE=1` reserved for DurableAgent.~~ **Deleted / superseded by [ADR 0029](0029-architecture-cleanup-no-compat.md)** — single Operator Event emit from Produce only; do not reintroduce a durable-produce path.

## Non-goals

- Self-driving multi-writer VCS coordination.
- Agent Networks (deprecated in Mastra).
- Compatibility with `adaptive`/`reviewer` workspace fields.
- Durable-produce / second Produce implementation (ADR 0029).
