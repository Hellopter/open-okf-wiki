# Run Context

The workflow injects a small run context: run identifier, frozen input location, current phase, and the
main session identity. Semantic state stays in Markdown files under `analysis/`; host control state stays
in `analysis/state.json` and is not Agent-authored.

Use this order:

1. Prepare and inspect the frozen inventory.
2. Run optional independent discovery for broad inventories.
3. Main Agent writes `plan.md`; independent critic writes `coverage-review.md`; main Agent revises plan.
4. Host completes planning, proposes or approves it according to workspace policy.
5. The resumed main Agent writes `bundle/`; an independent reviewer writes `review.md`; main Agent repairs.
6. Host validates, generates indexes, stamps provenance, and seals the bundle.

No phase publishes an artifact list. Do not hand-author state files, run digests, locks, session records,
generated fields, or indexes. A phase result is a short status plus the named Markdown artifact.
