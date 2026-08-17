---
name: wiki-production
description: Isolated Wiki Lead session brief for one source-grounded production run.
---

# Wiki production Lead

The host already started this run. Inspect authorized source and the candidate,
then finish through the supplied tools. Do not create workflow manifests,
source copies, or alternate plans.

1. Inspect authorized source deterministically. Inventory every declared source
   root, entry point, public boundary, important flow, persistence boundary,
   and candidate semantic domain. Keep source names as provenance scopes; do
   not promote a repository name to a domain without evidence.
2. Start one discovery logical wave for all ready, independent coverage
   assignments. Give each task explicit source, domain, and lens scopes, a
   stop condition, and a role-specific Markdown handoff. The host assigns
   opaque coverage IDs and carries them into the leaf contract. Queue the
   complete ready wave in one `wiki_delegate_start`; runtime concurrency
   controls actual sessions and retries remain attempts.
3. Collect discovery and reconcile taxonomy once, then submit the compact
   `wiki_taxonomy` checkpoint before `wiki_plan`. Record
   merge/split/rename decisions, source-local detail, cross-source relations,
   conflicts, and minority evidence. Root pages are cross-source synthesis;
   source/domain/concept pages retain local provenance. Then read
   [topology](references/topology.md) and submit the complete source-aware page
   path list with `wiki_plan`.
4. Before every `wiki_delegate_start` or `wiki_finish`, read
   `.okf-wiki/runs/<id>/board.md`. Dispatch from Remaining using those cluster
   ids. One cluster for write or review. If the board shows
   `directWriteAllowed: yes`, write that cluster yourself. Continue useful Lead
   work, then `wiki_delegate_collect` with the batch id shown on the board. Use
   `wiki_delegate_cancel` when pending work is no longer useful.
5. Read delegated Markdown artifacts by reference with bounded `read` calls.
   When passing an artifact to another task, copy its exact
   `receipt.outputs[].nodeId` into that task's `contextRefs`. Treat failed or
   incomplete receipts as missing coverage, never as evidence of absence.
6. A supplement is allowed only for a concrete unresolved gap, conflict, or
   failed task shown on the board. Use `mode: supplement` and put the exact
   blocker IDs in `resolvesIds`; never repeat a broad survey because writing
   has started or because a result was inconvenient.
7. Delegate independent review of every current cluster. Reviewers call
   `wiki_review_finish`. A write or plan revision invalidates prior passes.
8. Call `wiki_finish` only after the board shows every current page with
   passing review coverage.

`wiki_plan` envelope:

```json
{
  "pages": [
    "overview.md",
    "api/source.md",
    "api/billing/domain.md",
    "api/billing/invoice/concept.md",
    "api/billing/invoice/models.md"
  ]
}
```

JSON is only for small control envelopes (`wiki_plan`, task dispatch, and finish
tools), not for research, writing, review, or other prose handoffs.

## References

- [Topology](references/topology.md) — before `wiki_plan`
- `.okf-wiki/runs/<id>/board.md` — before every dispatch or `wiki_finish`
- [Evidence](references/common.md)
- [Researcher brief](briefs/researcher.md) · [research](references/research.md)
- [Writer brief](briefs/writer.md) · [writing](references/write.md)
- [Reviewer brief](briefs/reviewer.md) · [review](references/review.md)
