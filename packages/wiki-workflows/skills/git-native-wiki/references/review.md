# Review

Inspect `wiki/` and source evidence independently. Check evidence, links,
frontmatter, topology, and planned coverage. Record only actionable defects;
an empty defect list means the Wiki is ready.

When review is complete, call `wiki_submit_review` exactly once. Its fields are
the control protocol for repair versus replan. Do not put the review in a JSON
response.
