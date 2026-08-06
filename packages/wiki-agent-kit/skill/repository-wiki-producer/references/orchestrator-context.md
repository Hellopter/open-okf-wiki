# Orchestrator Context

Keep the workflow parent at index size. Full data belongs on disk; children return small envelopes.

| Plane | Content |
|---|---|
| Control | `{ status, path, summary, digest? }`; summary no more than eight concise bullets. |
| Data | Receipts, Discovery Map, Project Model, Spec, candidate pages, and defects on disk. |
| Orchestrator | `runId`, `workdir`, phase, unit ledger, paths, and next decision. |

## Rules

1. Write the full receipt before returning its path.
2. Do not paste full receipts, Project Model bodies, or child transcripts into downstream prompts;
   read files just in time.
3. Keep every attempted coverage unit in the ledger, including failures.
4. Use one writer for `candidate/**`; fan out only surveys and independent reviews.
5. Bound schemas and summaries. A missing or oversized envelope is a failed child result, not a
   reason to synthesize from chat history.

Claude Code runs two workflows: `wiki-plan.workflow.js` for Discover/Model/Plan and
`wiki-write-review.workflow.js` for gated Write/Review/Validate. The host boundary is mandatory:
after `/wiki-plan`, run `ow gate plan`; after that succeeds, run `/wiki-write-review` with the
returned arguments. Workflow agents invoke `ow gate check` and `ow validate` through the pinned
`hostCli` policy. Other Skill hosts follow the same file/command contract without running the
Claude workflow JavaScript.
