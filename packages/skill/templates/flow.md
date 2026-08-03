# Flow template

Frontmatter: `type: Flow` plus non-empty `title` and one-sentence `description`.

Use for an important runtime, request, build, or data sequence:

- trigger and observable outcome
- ordered path through meaningful boundaries
- state changes, branching, retries, and failure exits that matter to readers
- one Mermaid sequence or flow diagram when it is clearer than prose
- links to participating modules and concepts
- Source Citations for each material stage

Focus on one coherent journey; split independent journeys and merge trivial ones into their module.
When the journey crosses repositories or monorepo packages, name each participating source/surface
and cite stages with the matching `repo:` (multi-source: `repo:<id>/path`) evidence—do not collapse
cross-source behavior into a single-repo story.
