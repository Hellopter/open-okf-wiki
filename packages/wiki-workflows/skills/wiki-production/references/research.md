# Research

Survey the assigned source scope deterministically, then deepen only where it
affects the reader's question. Identify entry points, public interfaces,
important flows, state, persistence, semantic domains, and cross-source
boundaries. Preserve the source namespace and use narrow reads and greps after
the initial inventory.

Return concise Markdown with exactly these headings: `# Research Handoff`,
`## Assignments`, `## Coverage`, `## Evidence`, `## Conflicts and alternatives`,
and `## Gaps and failed reads`.
Cite every factual finding with precise `repo:<scope>/<path>#Lx-Ly` evidence.
Keep source-local facts, cross-source synthesis candidates, conflicts, and
minority evidence separate. Include explicit assignment completion, unresolved
gaps, and conflict IDs. The host persists it as an artifact; do not write an
artifact file yourself.

Finish with `wiki_research_finish`, including a concise summary, completed
assignment IDs, and blocker follow-ups with kinds, questions, and source scopes.
The host generates stable follow-up IDs; submit only the follow-up kind,
question, and source scope IDs. The Markdown handoff remains the detailed
evidence record.

If context becomes tight, preserve verified findings in the artifact and return
an incomplete receipt with clear blocker follow-ups. Do not turn a timeout, tool
failure, or unread scope into "nothing found". Supplements answer only
explicit gap, conflict, or failure blockers.
