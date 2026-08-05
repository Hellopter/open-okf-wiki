# Orchestrator Context and Handoffs

Keep the workflow parent at index size. A graph edge is a host-validated checkpoint, not an
unverified sentence in an agent response.

| Plane | Content |
|---|---|
| Control | `status`, proposal path, checkpoint path/digest, owner, short summary, open questions. |
| Data | Receipts, Discovery Map, Spec, assignments, candidate pages, defects on disk. |
| Orchestrator | RunContext, phase, checkpoint digest, path indexes, and budgets. |
| Workspace pointer | `.wiki-agent/current.json` identifies the active run and last trusted checkpoint. |

## Rules

1. Write the full receipt or artifact before returning a proposal path.
2. Run `ow checkpoint` after every graph boundary. The CLI recomputes artifact digests and rejects
   undeclared paths, stale inputs, duplicate owners, and missing dependencies.
3. Do not paste full receipts or child transcripts into downstream prompts. Read checkpoint-listed
   files just in time.
4. Keep every attempted coverage unit and every failed shard in the ledger.
5. `page-assignments.json` gives every candidate path one owner. A source/domain shard may write
   only its paths; the integration shard owns only overview, navigation, glossary, and cross-source
   Flow pages.
6. Bound schemas and summaries. A missing envelope is a failed child, not a reason to synthesize
   from chat history.
7. Repair routes only to the defect owner. A repeated defect fingerprint or no reduction in
   blocking/major defects is a stop condition, not a reason to loop indefinitely.
8. Host actions are deterministic agent APIs. Agents invoke the exact pinned command from
   `inputs/run-policy.json`; the native `/wiki` workflow is the only user entrypoint.
9. A validate handoff may publish only from the current clean `review-N` leaf. `ow validate` is
   idempotent for a valid manifest so an interrupted terminal checkpoint can resume without rewriting.
