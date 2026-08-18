# Review

Review every Candidate path and profile check in `.okf-wiki/task/brief.md`
independently against authorized Source. Do not edit Candidate pages.

Start `.okf-wiki/task/review.md` with this exact YAML frontmatter shape. Use
`findings: []` for a pass. The host creates finding identities and binds the
review to its assigned paths. Copy each finding path exactly from `brief.md`;
severity is `critical`, `major`, or `minor`.

```yaml
---
findings:
  - path: wiki/example.md
    severity: major
profileCoverage:
  - evidence-fidelity
---
```

Then write exactly these Markdown headings:
`# Review Handoff`, `## Findings`, and `## Evidence`. For each finding, give
severity, exact Candidate path, concise corrective action, and
source-qualified evidence. Check evidence fidelity, missing coverage,
misleading topology, broken semantic links, terminology, depth, source-local
detail, minority/conflict preservation, and whether diagrams agree with cited
behavior. Root pages must synthesize across Sources without erasing local
provenance. `## Evidence` must include at least one
Markdown source citation from `common.md`, including on a pass.

After the review file covers the complete brief, call `wiki_review_finish`
with only `verdict: pass` or `verdict: changes_requested`. Use
`changes_requested` when `review.md` contains any required correction or a
Source could not be checked. If the host rejects the file, fix every named
defect in the same rewrite of `review.md`, then finish again. Do not call
finish again on the unchanged file. The
host binds the accepted file to the exact Review Assignment and persists its
structured findings.

Deterministic syntax diagnostics remain host-owned. A failed read or unavailable
Source is a review gap, not a pass.
