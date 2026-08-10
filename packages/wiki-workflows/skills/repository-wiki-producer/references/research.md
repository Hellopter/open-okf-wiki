# Structured Research

Read only the `sourcePaths` in the assigned scope. A scope may span multiple
declared source roots. Inventory entry points, modules, interfaces, domain
concepts, state and persistence, end-to-end flows, and cross-repository
boundaries relevant to the assigned reader question. Do not stop at filenames
or exported symbols.

Write one JSON research artifact to the exact handoff path and call
`wiki_submit_research` with that path. Submit an artifact even when no finding
is established. Use exactly this shape:

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
non-empty evidence array of precise repo-local ranges. Use `critical` only when
omitting the finding would leave a public boundary, defining concept, important
state invariant, or end-to-end behavior unexplained. The engine derives a
stable `findingId` from `kind` and sorted evidence; never add an ID yourself.

Record every unresolved claim in `gaps`; use `[]` only after actively checking
the assigned question. Gap `sourcePaths` are investigation suggestions and
must come from the authorized scope. Do not infer a relationship, hierarchy,
sequence, or state transition from names alone.

Do not edit `wiki/`. Keep `summary` concise and prefer precise evidence over
copied source or tool narration. Keep the artifact below 256 KiB.

Record source-authored domain and concept names or aliases as findings,
especially corresponding Chinese names found in code or comments. Preserve
their exact spelling, cite the defining span, and do not replace them with your
own translation.
