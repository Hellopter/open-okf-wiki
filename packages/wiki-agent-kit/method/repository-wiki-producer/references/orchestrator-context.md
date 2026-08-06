# Orchestrator Context

The workflow parent carries only the run context, phase, checkpoint digest, and bounded child
envelopes. Receipts, maps, specifications, pages, defects, and validation output stay on disk.

| Plane | Content |
|---|---|
| Checkpoint | `analysis/checkpoints/*.json`, written only by `ow publish`. |
| Data | Receipts, Discovery Map, Spec, assignments, candidate pages, defects, and validation output. |
| Workspace pointer | `.wiki-agent/current.json` identifies the active run and last trusted checkpoint. |

## Publishing a phase

Agents write data-plane files first, then write one artifact list under `analysis/receipts/`:

```json
[
  { "id": "discovery-map", "type": "discovery-map", "path": "analysis/discovery-map.json", "coverageUnitIds": ["app"] }
]
```

Only discover artifacts may declare `coverageUnitIds`. The host runs:

```bash
ow publish --phase <phase> --artifacts-json analysis/receipts/<phase>-artifacts.json
```

The CLI validates each listed path, computes its digest, derives the required predecessor checkpoint,
and advances the active pointer atomically. Do not write checkpoint JSON, checkpoint digests, phase
metadata, producer identities, ownership metadata, or artifact dependencies.

## Rules

1. Publish once after every completed graph boundary.
2. Do not paste full receipts or child transcripts into later prompts; read checkpoint-listed files just in time.
3. Discover artifacts must collectively cover every required inventory unit.
4. `page-assignments.json` is the only owner map for candidate paths.
5. Host actions use the pinned command in `inputs/run-policy.json`; `/wiki` is the user entry.
6. The validate phase can publish only from a clean current `review-N` checkpoint.
