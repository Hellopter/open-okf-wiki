# Structured Research

Read only the `sourcePaths` in the assigned scope. A scope may span multiple
declared source roots. Perform a **bounded survey**: inventory entry points,
main modules and interfaces, primary end-to-end flows, cross-repository
boundaries, and state or persistence relevant to the assigned reader question.
Do not aim for an exhaustive encyclopedia of every file or symbol.

Write one JSON research artifact to the exact handoff path and call
`wiki_submit_research` with that path. Submit a **complete handoff in one pass**
even when no finding is established. Do not plan multi-turn exploration across
submissions for the same assignment. Use exactly this shape:

```json
{
  "summary": "Concise account of the inspected scope and result",
  "findings": [
    {
      "kind": "domain|concept|flow|boundary|state-data",
      "title": "A source-grounded finding",
      "readerQuestion": "The independent reader question this answers",
      "priority": "critical|normal",
      "evidence": ["project/path.ext#L10-L24"]
    }
  ],
  "gaps": [
    {
      "question": "What remains unverified?",
      "priority": "critical|normal",
      "sourcePaths": ["project"]
    }
  ]
}
```

Each finding must answer one independently useful reader question and contain a
non-empty evidence array of precise repo-local ranges. Prefer **critical**
findings for public boundaries, defining concepts, important state invariants,
and end-to-end behavior that a reader must understand; use `normal` for useful
but secondary detail. The engine derives a stable `findingId` from `scopeId`,
`kind`, and sorted evidence; never add an ID yourself.

Record every unresolved claim in `gaps`; use `[]` only after actively checking
the assigned question. Gap `sourcePaths` are investigation suggestions and
must come from the authorized scope. Do not infer a relationship, hierarchy,
sequence, or state transition from names alone.

Do not edit `wiki/`. Keep `summary` concise and prefer precise evidence over
copied source or tool narration. Keep the artifact below 256 KiB.

## Context pressure and evidence discipline

Survey tools return bounded excerpts. Prefer narrow paths and targeted greps
over wide inventories. When context pressure rises, **stop exploring**: write
the complete handoff with the best critical findings and explicit gaps you have,
submit once, and finish. Cite only evidence ranges from files you actually read
in this session. Invented or unread ranges are hard-rejected; there is no clamp
or silent repair of line numbers.

Record source-authored domain and concept names or aliases as findings,
especially corresponding Chinese names found in code or comments. Preserve
their exact spelling, cite the defining span, and do not replace them with your
own translation.
