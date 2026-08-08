# Independent Criticism and Review

Critics and reviewers are independent read-only evaluators. They may write only their assigned Markdown
report. They do not alter `analysis/plan.md`, `bundle/`, run state, or sources. Reports must be concise,
actionable, and cite the frozen evidence or exact page path that supports each finding.

Every coverage or final report has these exact non-empty single-line fields:

```md
Verdict: PASS|FAIL
Affected pages: None | bundle-relative page paths
Findings: None | concrete evidence-backed findings
Required repair: None | concrete repair
```

The coverage re-review and every final report must be `PASS` before sealing. The initial coverage report
may be `FAIL`, because it records gaps repaired before re-review. A `FAIL` report cannot use `None` for
findings or required repair.

## Coverage critic

Read `analysis/inventory.md`, `analysis/plan.md`, relevant briefs in `analysis/discovery/sources/`, the
optional `analysis/discovery/integration.md`, and enough frozen sources to test a suspected omission. Write
`analysis/coverage-review.md` with:

```md
# Coverage Review

Verdict: PASS|FAIL
Affected pages: None | bundle-relative planned pages
Findings: None | inventory/evidence-backed coverage gaps
Required repair: None | concrete plan/evidence change
```

Check that required inventory units are covered by the Page Matrix, domains model concepts rather than
directory names, and cross-domain workflows are present where the evidence warrants them. Do not demand
an independent page for every source file. After the main Agent repairs the plan, repeat this review at
`analysis/reviews/coverage-rereview.md`; it must be `PASS` before planning completes.

## Final quality reviewers

Read `analysis/plan.md`, `analysis/coverage-review.md`, `bundle/`, and frozen evidence. Write one assigned
report under `analysis/reviews/`: `evidence.md`, `workflow.md`, `navigation.md`, or `reader-qa.md`.

- **Evidence** checks page-matrix coverage, evidence briefs, citations, and factual support.
- **Workflow** checks state, failure/retry behavior, cross-domain flows, and Mermaid decisions. Mermaid
  diagrams must be source-grounded; the host runs conservative local structural validation, not browser rendering.
- **Navigation** checks hierarchy, links, change safety, configuration, and validation/rollback paths.
- **Reader QA** derives reader questions from frozen source/test evidence, then verifies answers using only the Wiki.

Across these reports, check:

- planned pages and required coverage decisions are reflected in the bundle;
- each authored page has valid frontmatter and a distinct reader purpose;
- source citations and internal links resolve and claims agree with cited frozen source;
- domain/concept hierarchy is understandable, including cross-domain workflows;
- prose matches `wikiLanguage` and is not a thin restatement of directory names.

Report only evidence-backed defects. A blocking finding means the Wiki cannot truthfully meet its planned
scope; a major finding materially impairs understanding; a minor finding is editorial. Do not use JSON,
artifact lists, receipts, checkpoints, or automated repair instructions. The main Agent repairs once, then
only failed reports are re-verified. A second failure blocks sealing.
