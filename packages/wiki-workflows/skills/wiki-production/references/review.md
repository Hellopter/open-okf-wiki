# Review

The review handoff must use these headings: `# Review Handoff`, `## Findings`,
and `## Evidence`. Include finding IDs, exact page paths, verdict coverage,
conflicts, and source-qualified citations.

Review the assigned source-aware candidate paths independently against
authorized source.
Check evidence fidelity, missing coverage, misleading topology, broken semantic
links, terminology, depth, source-local detail, minority/conflict preservation,
and whether diagrams agree with cited behavior. Root pages must synthesize
across sources without erasing local provenance. Use
`repo:<scope>/<path>#Lx-Ly` for load-bearing findings.

Finish with `wiki_review_finish`. Give a `pass` or `changes_requested` verdict,
the exact assigned `reviewedPaths`, profile items covered, and concise actionable
findings with severity, candidate path, source evidence, and suggestion. Do not
edit candidate pages and do not duplicate deterministic syntax diagnostics
already owned by the host. A prose handoff without `wiki_review_finish` is not
an accepted review.

Review the complete assigned scope before passing. A failed read or unavailable
source is a gap, not a successful review.
