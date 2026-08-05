# Orchestrator Context

Keep the workflow parent at index size. Full data belongs on disk; children return small envelopes.

| Plane | Content |
|---|---|
| Control | `{ status, path, summary, digest? }`; summary no more than eight concise bullets. |
| Data | Receipts, Discovery Map, Spec, candidate pages, and defects on disk. |
| Orchestrator | `runId`, `workdir`, phase, unit ledger, paths, and next decision. |
| Workspace pointer | `.wiki-agent/current.json` and `next-action.json` identify the active run without chat args. |
| Human entry | `/wiki` entry skill (not this method pack). |

## Rules

1. Write the full receipt before returning its path.
2. Do not paste full receipts or child transcripts into downstream prompts; read files just in time.
3. Keep every attempted coverage unit in the ledger, including failures.
4. Use one writer for `candidate/**`; fan out only surveys and independent reviews.
5. Bound schemas and summaries. A missing or oversized envelope is a failed child result, not a
   reason to synthesize from chat history.
6. Prefer no-arg workflow invocation. Resolve run identity from args, then workspace pointers, then
   newest valid run under `.wiki-agent/runs/`.
7. Host CLI actions (`gate plan`, `gate check`, `validate`) are deterministic **agent API** tools.
   Workflow agents run them through pinned `hostCli` from `inputs/run-policy.json`. Humans use `/wiki`.

## Claude workflows

| Workflow | Boundary |
|---|---|
| `wiki-produce.workflow.js` | Real multi-phase E2E: Resolve→Discover→Plan→Gate→Preflight→Write→Review→Repair→Validate. |
| `wiki-plan.workflow.js` | Discover/Plan; auto `ow gate plan` unless `approvePlan`. |
| `wiki-write-review.workflow.js` | Preflight gate check → write → review → validate. |

Default human path: `/wiki` → freeze if needed → `/wiki-produce`. Split workflows are advanced/recovery.

After a successful auto plan gate, pointers advance to `/wiki-write-review`. After seal, phase is
`sealed` / command `done`. Human approval mode uses host `ow approve plan` between plan and write.
