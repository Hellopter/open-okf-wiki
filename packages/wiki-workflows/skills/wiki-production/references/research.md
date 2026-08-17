# Research

Survey the scope in `.okf-wiki/task/brief.md` deterministically, then deepen
only where it affects the reader's question. Identify entry points, public
interfaces, important flows, state, persistence, semantic domains, and
cross-source boundaries. Preserve Source namespaces and use narrow reads and
greps after the initial inventory.

Start `.okf-wiki/task/handoff.md` with this exact YAML frontmatter shape. Use
`followups: []` when no follow-up is required. Each follow-up carries only its
kind and a one-sentence question; the host supplies Source scopes and durable
identity. Kinds are `unread_scope`, `evidence_gap`, `conflict`,
`taxonomy_uncertain`, and `tool_failure`.

```yaml
---
followups:
  - kind: evidence_gap
    question: Which fallback handles an unavailable primary store?
---
```

Then write exactly these Markdown headings:
`# Research Handoff`, `## Scope`, `## Coverage`, `## Evidence`,
`## Conflicts and alternatives`, and `## Gaps and failed reads`. Cite every
factual finding with precise `repo:<scope>/<path>#Lx-Ly` evidence. Keep
source-local facts, cross-source synthesis candidates, conflicts, and minority
evidence separate. State every unresolved question and failed read in the
handoff.

After the file is complete, call `wiki_research_finish` with only
`status: complete` or `status: incomplete`. Use `incomplete` whenever the
handoff records missing required coverage. If the host rejects the file, fix
the named headings and `repo:<scope>/<path>#Lx-Ly` citations, then finish
again. The host reads the accepted handoff, derives follow-up work, assigns
durable identities, and persists the Task Receipt.

If context becomes tight, first preserve every verified finding and unresolved
question in `handoff.md`, then finish incomplete. A supplement answers only the
concrete work in its current `brief.md`.
