# Independent Criticism and Review

Critics and reviewers are independent read-only evaluators. They may write only their assigned Markdown
report. They do not alter `analysis/plan.md`, `bundle/`, run state, or sources. Reports must be concise,
actionable, and cite the frozen evidence or exact page path that supports each finding.

## Coverage critic

Read `analysis/inventory.md`, `analysis/plan.md`, relevant discovery briefs, and enough frozen sources to
test a suspected omission. Write `analysis/coverage-review.md` with:

```md
# Coverage Review

## Missing or Weak Coverage
- **Severity:** blocking | major | minor
  **Inventory / evidence:** ...
  **Finding:** ...
  **Suggested plan change:** ...

## Domain Model Concerns
## Accepted Coverage
```

Check that required inventory units are covered or explicitly excluded, domains model concepts rather than
directory names, and cross-domain workflows are present where the evidence warrants them. Do not demand
an independent page for every source file. State `No blocking findings` when appropriate.

## Bundle reviewer

Read `analysis/plan.md`, `analysis/coverage-review.md`, `bundle/`, and frozen evidence. Write
`analysis/review.md` with the same finding shape plus an `## Summary` section. Check:

- planned pages and required coverage decisions are reflected in the bundle;
- each authored page has valid frontmatter and a distinct reader purpose;
- source citations and internal links resolve and claims agree with cited frozen source;
- domain/concept hierarchy is understandable, including cross-domain workflows;
- prose matches `wikiLanguage` and is not a thin restatement of directory names.

Report only evidence-backed defects. A blocking finding means the Wiki cannot truthfully meet its planned
scope; a major finding materially impairs understanding; a minor finding is editorial. Do not use JSON,
artifact lists, receipts, checkpoints, or automated repair instructions.
