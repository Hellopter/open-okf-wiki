# Orchestrator Context and Handoffs

Keep the workflow parent at index size. A graph edge is a host-validated checkpoint, not an
unverified sentence in an agent response.

| Plane | Content |
|---|---|
| Control | `status`, proposal path, checkpoint path/digest, owner, short summary, open questions. |
| Data | Receipts, Discovery Map, Spec, assignments, candidate pages, defects on disk. |
| Orchestrator | RunContext, phase, checkpoint digest, path indexes, and budgets. |
| Workspace pointer | `.wiki-agent/current.json` identifies the active run and last trusted checkpoint. |

## Handoff proposal contract (all phases)

Every file under `analysis/handoffs/**` that is passed to `ow checkpoint --phase <phase>` MUST match
`schemas/handoff-proposal.schema.json`:

```json
{
  "version": 2,
  "phase": "<exact checkpoint phase>",
  "inputCheckpointDigests": [],
  "producer": "owner-id",
  "status": "complete",
  "artifacts": [
    {
      "id": "artifact-id",
      "type": "discovery-map",
      "owner": "owner-id",
      "path": "analysis/discovery-map.json",
      "dependsOn": []
    }
  ],
  "summary": "short summary",
  "openQuestions": []
}
```

| Field | Rule |
|---|---|
| `version` | **Number `2` only.** Not `1`, not `"2"`. Host rejects anything else. |
| `phase` | Must equal the later `ow checkpoint --phase` value (`discover`, `plan`, `write-sources`, `write`, `review-N`, `repair-N`, `blocked-N`, `validate`, …). |
| `inputCheckpointDigests` | Discover uses `[]`. Later phases list predecessor checkpoint digests exactly. |
| `producer` | Non-empty owner id matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`. |
| `artifacts` | At least one; each has `id`, `type`, `owner`, `path`, `dependsOn`. |

**Do not copy version numbers from data-plane files.** These may legitimately be `1` while handoffs stay `2`:

- `inputs/inventory.json`, `inputs/snapshot-manifest.json`, `inputs/discovery-map.json`
- `analysis/discovery-map.json`
- `analysis/candidate.manifest.json`

Spec and defects use version `2` for their own schemas; that still does not replace the handoff
proposal contract.

Child agents return only a short envelope `{status, proposalPath, summary, openQuestions}` (plus phase
fields such as `missingUnitIds` or review metrics). The proposal file on disk is the authority the
checkpoint command validates.

## Rules

1. Write the full receipt or artifact before returning a proposal path.
2. Run `ow checkpoint` after every graph boundary. The CLI recomputes artifact digests and rejects
   undeclared paths, stale inputs, duplicate owners, missing dependencies, and non-v2 proposals.
3. Do not paste full receipts or child transcripts into downstream prompts. Read checkpoint-listed
   files just in time.
4. Keep every attempted coverage unit and every failed shard in the ledger.
5. Pack fan-out waves fairly by source under `inputs/run-policy.json` limits (`batchConcurrency`,
   `perSourceConcurrency`, `maxCoveragePasses`, `maxRepairRounds`).
6. `page-assignments.json` gives every candidate path one owner. A source/domain shard may write
   only its paths; the integration shard owns only overview, navigation, glossary, and cross-source
   Flow pages.
7. Bound schemas and summaries. A missing envelope is a failed child, not a reason to synthesize
   from chat history.
8. Repair routes only to the defect owner. A repeated defect fingerprint or no reduction in
   blocking/major defects is a stop condition, not a reason to loop indefinitely.
9. Host actions are deterministic agent APIs. Agents invoke the exact pinned command from
   `inputs/run-policy.json`; the native `/wiki` workflow is the only user entrypoint.
10. A validate handoff may publish only from the current clean `review-N` leaf. `ow validate` is
    idempotent for a valid manifest so an interrupted terminal checkpoint can resume without rewriting.
