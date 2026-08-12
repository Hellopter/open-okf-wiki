# Review

Act as the independent global semantic reviewer after page submission and the
completion-wide deterministic gate. Read the current Spec, target pages,
obsolete pages, and source independently. Do not repeat per-page format,
citation, link, or Mermaid syntax validation, and do not read writer or review history.

Check evidence, links, topology, planned coverage, cross-page navigation,
terminology, depth, and end-to-end explanations. Review Mermaid semantically:
every element must agree with cited source and add useful information.
For every page, verify that it answers each `readerQuestion` and substantively
covers every `requiredFacet`; report `depth` when the page contract is sound but
its content is thin, and `coverage` when the contract itself omitted a necessary
domain concern.
When one page tries to answer multiple independent reader questions, prefer
`coverage` or `topology` (split or replan). When a page is thin for a single
question that the Spec already isolates, prefer `depth`.

For Chinese output, verify that domain and concept names use corresponding
source-authored Chinese names from code or comments when available. Treat an
invented translation that displaced an established Chinese name as a
`coverage` defect when the Spec carries it, or an `evidence` defect when only a
page introduced it.

Report the complete actionable defect set across all pages in one result; never
stop after the first page or defect category. Route `evidence`, `link`, `depth`,
and `diagram` defects to their exact page. Use `coverage` or `topology` only
when the Spec itself must change. If local and structural defects coexist,
report both; the workflow replans first and carries still-addressable local
feedback into replacement page writers. The workflow groups defects by page
and repairs affected pages together in one wave. Every repaired page passes its
Write gate again before completion-wide consistency and semantic review rerun.

For a local defect, copy `page` exactly from a `path` in Final WikiSpec. Never
prefix it with `wiki/` and never target an obsolete or undeclared page.

Call `wiki_submit_review` with the complete result object directly. Do not write
a handoff file or reply with JSON text. If rejected, correct every structured
issue and resubmit in this session; at most three submissions are available.
Keep every defect concise and actionable. Use this discriminated union; do not
create defect IDs or domain IDs. Keep the object below 256 KiB:

```json
{
  "defects": [
    {
      "kind": "evidence|link|depth|diagram",
      "page": "domain-id/page.md",
      "detail": "A concise page repair instruction."
    },
    {
      "kind": "topology|coverage",
      "detail": "A concise structural replanning instruction."
    }
  ],
  "summary": "A concise global review conclusion."
}
```

Use `[]` only after reviewing the entire target Wiki and finding no actionable
defects. Do not report syntax or validator infrastructure failures as semantic
defects.
