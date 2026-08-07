# Root Overview Guidance

The host generates `bundle/index.md`; do not turn it into a narrative. A repository-wide overview belongs
in a domain overview or a shared concept only when it answers a real reader question that cannot be owned
by a smaller domain.

When such a page is warranted:

- explain the product's purpose and the smallest useful mental model;
- introduce the major domains and their most important relationships;
- link to the domain pages readers should visit next;
- cite source-grounded factual statements;
- keep the hierarchy conceptual rather than mirroring the repository tree.

Use `type: concept` or `type: domain` according to the plan, plus non-empty `title` and `sources` entries
with stable `id` values and `inputs/sources/...#Lx-Ly` resources.
