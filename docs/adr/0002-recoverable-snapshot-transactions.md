# Recoverable snapshot transactions

Run state is committed as a versioned, recoverable snapshot transaction that contains the event and every observable projection changed by it. A write-ahead transaction is the commit authority and recovery rolls it forward idempotently, so callers receive an event and matching view without reconstructing state from loosely ordered files.

The retained event log is not a second snapshot. After the journal applies, `events/*.json` keep only the event. The current Run view is `run-state.json`. The pinned production plan is written once to `production-plan.json`. `updates()` pairs each retained event with the current snapshot at read time. Live Agent process tails project into the widget; they are not stored on the Run snapshot.

Publication retains its separate rename journal because installing the Candidate changes a different filesystem lifetime and cannot share an atomic commit with Run state. A Workspace publication lease serializes the journal and filesystem swap across instances and processes. If installation is durable but the Run terminal transaction is not, recovery projects the committed publication into that transaction. Only after the Run terminal transition is durable is the active journal acknowledged into a per-Run audit archive. Archived journals remain evidence but are excluded from future recovery, so a later full-generation Run is never checked against an earlier Published Wiki digest.

Live agent telemetry uses replaceable sidecar checkpoints. A checkpoint writes a
versioned `pending-sidecar.json` journal containing only the touched agent record
and one fixed-size aggregate usage value. Recovery rolls that journal forward
idempotently into `usage-checkpoint.json` and the agent record, then removes the
journal; it never rewrites the run snapshot or a target-sized usage map. The
run-state reader overlays that aggregate, and the next durable transaction
carries it into the durable snapshot before removing the checkpoint. Sidecars
do not allocate event sequences: subscribers receive the same durable event
sequence with a larger update revision, while durable transitions remain
ordered and replayable from the event ledger.
