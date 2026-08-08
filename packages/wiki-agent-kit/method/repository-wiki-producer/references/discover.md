# Independent Discovery

Discovery is optional and only for broad inventories. The workflow gives each discovery Agent a bounded
source or conceptual area. It is for evidence gathering, not for proposing a complete Wiki or returning a
machine-validated receipt.

Read the assigned inventory entries and frozen content under `inputs/sources/`. A source researcher writes
one concise report at its assigned `analysis/discovery/sources/<slug>.md` path. The single cross-source
integration researcher, when assigned for a multi-source run, writes
`analysis/discovery/integration.md` instead:

```md
# Discovery: <scope>

## What This Area Does
## Candidate Domains and Concepts
## Important Flows and Relationships
## Evidence
## Uncertainties
```

Use source citations with actual one-based line ranges. Describe likely boundaries and unresolved facts;
do not decide the final hierarchy, write bundle pages, modify the plan, or infer coverage from filenames
alone. Never write JSON, receipts, retry markers, or artifact lists. Return a short status after the brief
is complete.
