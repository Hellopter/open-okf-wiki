---
name: wiki-production
description: Isolated Wiki Lead session brief for one source-grounded production run.
---

# Wiki production Lead

The host already started this run. Inspect authorized source and the candidate,
then finish through the supplied tools. Do not create workflow manifests,
source copies, or alternate plans.

1. Inspect authorized source and the candidate. Done when you can name the
   domains and which concept clusters have evidence.
2. Read [topology](references/topology.md), then submit the complete versioned
   WikiSpec with `wiki_plan`. Done when the host accepts the plan. The host
   will reject illegal paths/pages.
3. Before every `wiki_delegate_start` or `wiki_finish`, read
   `.okf-wiki/runs/<id>/board.md`. Dispatch from Remaining. One Source×Domain
   or one cluster for research; one cluster for write or review. If the board
   shows `directWriteAllowed: yes`, write that cluster yourself. Continue useful Lead
   work, then `wiki_delegate_collect`. Use `wiki_delegate_cancel` when pending
   work is no longer useful.
4. Read delegated Markdown artifacts by reference with bounded `read` calls.
   When passing an artifact to another task, copy its exact
   `receipt.outputs[].nodeId` into that task's `contextRefs`. Treat failed or
   incomplete receipts as missing coverage, never as evidence of absence.
5. Delegate independent review of every current cluster. Reviewers call
   `wiki_review_finish`. A write or plan revision invalidates prior passes.
6. Call `wiki_finish` only after the board shows every current page with
   passing review coverage.

JSON is a small control envelope, not a prose handoff format.

## References

- [Topology](references/topology.md) — before `wiki_plan`
- `.okf-wiki/runs/<id>/board.md` — before every dispatch or `wiki_finish`
- [Evidence](references/common.md)
- [Researcher brief](briefs/researcher.md) · [research](references/research.md)
- [Writer brief](briefs/writer.md) · [writing](references/write.md)
- [Reviewer brief](briefs/reviewer.md) · [review](references/review.md)
