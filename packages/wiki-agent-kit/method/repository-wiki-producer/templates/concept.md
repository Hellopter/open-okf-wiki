# Concept Template

Use for a domain-specific or shared concept with a distinct reader question.

- Explain the concept, its practical relevance, and the boundary it owns.
- Describe rules, lifecycle, inputs, outputs, and failure behavior only when source evidence supports them.
- Link to the domain overview and concepts/workflows where readers apply it.
- Keep source citations next to the claims they support.

Use `type: concept`, a clear `title`, and non-empty `sources` frontmatter. Each source needs a stable `id`
and an `inputs/sources/...#Lx-Ly` resource. Merge it into a neighboring page when it would only restate a
file or implementation name.
