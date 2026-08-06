# Reduce Discovery

`ow survey-merge --pass <n>` is the sole authority for reducing survey work. It reads receipts, validates
their schema/evidence/path bounds, selects the latest valid receipt for each inventory unit, and writes the
Discovery Map plus `discovery-artifacts-pass-<n>.json`.

- Missing or retryable receipts are retried only within the workflow pass budget.
- A valid non-retryable `failed` or `skipped` receipt is retained as an explicit insufficiency. It may let
  Discover checkpoint, but Plan must cancel that unit with a reason and cannot bind it to a page or domain.
- The map's domains and flows come from receipt `plannerHints`. Only when a non-L0 final map has no domain
  may the workflow write a short `discovery-labels` file and rerun the same host merge.
- Never hand-author a discover artifact list or claim coverage through the map alone. `ow publish --phase
  discover` requires one valid, selected receipt artifact per required unit. The host-generated list includes
  itself as a merge artifact; publishing replays that list and the worker receipts, so a stale or hand-built
  list is rejected.
