# Planning

Inspect the declared source projects before producing a Draft Plan. This phase
proposes candidate domains, reader questions, candidate pages, and the source
research needed to resolve evidence-heavy gaps; it does not freeze the final
page set. Each candidate must answer a distinct reader question and name the
source ranges likely to support it.

Split research by independent source boundary or unanswered question. Scopes
must not overlap, must be source-only, and must not exceed four concurrent
workers. Identify likely cross-domain flows and data or state boundaries so
synthesis can determine whether follow-up research or a diagram is warranted.
Do not assign a diagram merely because a page has a familiar name.

When the Draft Plan is complete, call `wiki_submit_plan` exactly once. Its
fields are the control protocol for the workflow. Do not put the plan in a JSON
response.
