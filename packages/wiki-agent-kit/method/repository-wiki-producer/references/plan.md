# Plan

Create and maintain the authoritative Markdown plan at `analysis/plan.md` before writing any bundle page.
It is working memory for the same main Agent that will later write the Wiki, not a JSON contract for
other workers.

## Inputs

Read `inputs/run-policy.json`, `analysis/inventory.md`, and only the frozen source spans needed to make
the initial hierarchy credible. When present, read relevant source briefs in
`analysis/discovery/sources/` and the cross-source brief at `analysis/discovery/integration.md`. Do not
ask discovery agents to repeat work already visible in the inventory or source tree.

## Required plan content

Use ordinary Markdown with these headings. Keep tables concise and use links to source spans instead of
copying evidence into the plan.

```md
# Wiki Plan: <title>

## Goal and Scope
## Domain Tree
## Planned Pages
## Cross-domain Relationships
## Coverage Decisions
## Open Questions and Exclusions
```

- **Goal and Scope** states the reader, focus, and factual boundary.
- **Domain Tree** names a small conceptual hierarchy. A domain is a coherent problem area, not merely a
  source directory or package name.
- **Planned Pages** gives each page's relative path below `bundle/`, page type, reader question,
  domains, and the inventory units/source evidence it covers. Put domain-local concepts under
  `domains/<domain>/`; put genuine cross-domain concepts and workflows under `concepts/`.
- **Cross-domain Relationships** records the meaningful flows, shared concepts, and links the prose must
  explain. Do not create a page merely because a dependency edge exists.
- **Coverage Decisions** maps every required inventory unit to one or more planned pages, or explicitly
  excludes it with a reason grounded in scope or unavailable evidence.
- **Open Questions and Exclusions** distinguishes unresolved evidence from intentional scope boundaries.

## Page Matrix and evidence briefs

The host seals only a plan with one contiguous `## Page Matrix` Markdown table. It has exactly these
required columns: `Page`, `Coverage Units`, `Evidence Brief`, and `Diagram`. Each page row names a
bundle-relative domain/concept page, one or more required coverage-unit ids, an existing
`analysis/evidence/*.md` brief, and a diagram decision of `required`, `useful`, or `omitted`.

Write the brief before the row. It is concise and cites frozen source lines while recording the page's
entry point, state/data changes, failure or retry behavior, upstream/downstream relationships, and tests.
Every generated page must appear once in the matrix; required inventory units cannot be excluded from the
matrix. A `required` decision means the page must contain an evidence-backed Mermaid diagram.

Plan enough pages to answer distinct reader questions, but merge thin or duplicate pages. Do not plan
`index.md`, `log.md`, artificial module pages, owner assignments, receipts, or checkpoints.

## Coverage criticism and proposal

After the initial plan, the coverage critic writes `analysis/coverage-review.md`. Read it, re-open the
named evidence where necessary, and revise `analysis/plan.md` to resolve supported omissions. A second
critic writes `analysis/reviews/coverage-rereview.md`; it must pass before approval. Record a reason when
rejecting a critique. Do not start bundle writing until the host marks planning complete; in proposal mode,
do not write bundle pages until approval resumes this run.

The host binds the approved plan digest to the frozen input digest. Changing the plan after proposal
requires a new planning completion rather than silently continuing with a different plan.
