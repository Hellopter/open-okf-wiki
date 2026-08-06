# Orchestrator Context and Handoffs

Keep the workflow parent at index size. A graph edge is a host-validated checkpoint, not an
unverified sentence in an agent response.

| Plane | Content |
|---|---|
| Control | Host-authored handoff proposals + checkpoints (`version: 2`). |
| Data | Receipts, Discovery Map, Spec, assignments, candidate pages, defects on disk. |
| Orchestrator | RunContext, phase, checkpoint digest, path indexes, and budgets. |
| Workspace pointer | `.wiki-agent/current.json` identifies the active run and last trusted checkpoint. |

## Host-authored handoffs

Agents **must not** freeform-write `analysis/handoffs/**` proposal JSON (no inventing `version` or
`phase`). Protocol fields are emitted only by the host CLI:

```bash
ow handoff write|publish --phase <phase> --out <path> --producer <id> \
  [--digest D]... [--artifact id:type:owner:path[:deps]]... \
  [--artifacts-json REL] [--summary S] [--status complete|blocked]
```

- `handoff write` — create/overwrite a version-2 proposal file.
- `handoff publish` — write proposal then `checkpoint` in one step (preferred at graph edges).
- `handoff validate` — shape-check without publishing.

Always `version: 2` (number). Data-plane files may use other versions (`inventory`/`discovery-map` often
`1`; Spec/defects `2`) — never copy those into handoff proposals.

Agents write data-plane artifacts, then write `analysis/receipts/*-artifacts.json` as an array of
`{id,type,owner,path,dependsOn,...}` **without** `version`/`phase`. Return a short envelope; the
workflow invokes `ow handoff publish`.

## Rules

1. Write the full receipt or artifact before asking the host to publish a handoff.
2. Run `ow handoff publish` (or write + `ow checkpoint`) after every graph boundary.
3. Do not paste full receipts or child transcripts into downstream prompts. Read checkpoint-listed
   files just in time.
4. Keep every attempted coverage unit and every failed shard in the ledger.
5. Pack fan-out waves fairly by source under `inputs/run-policy.json` limits (`batchConcurrency`,
   `perSourceConcurrency`, `maxCoveragePasses`, `maxRepairRounds`).
6. `page-assignments.json` gives every candidate path one owner.
7. Bound schemas and summaries. A missing envelope is a failed child, not a reason to synthesize
   from chat history.
8. Repair routes only to the defect owner; stop on repeated defect fingerprints.
9. Host actions use the pinned command from `inputs/run-policy.json`; `/wiki` is the only user entry.
10. Validate handoffs publish only from a clean current `review-N` leaf.
