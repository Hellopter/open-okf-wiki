---
name: repository-wiki-producer
description: Produce or refresh a source-grounded repository Wiki from projects declared in a local Pi workspace. Use when asked to document repositories, generate a Wiki, or update existing Wiki pages after source changes.
---

# Repository Wiki Producer

Treat every project declared by `workspace.yaml` as source of truth. Use
`/wiki generate` for an initial Wiki and `/wiki refresh` after source changes.
The workspace language is selected by `/wiki init --lang zh|en`; use `lang=en`
only for a one-run override.

Do not clone repositories, create source registries, copy source trees,
snapshot inputs, or write run manifests. Source onboarding is performed by the
user through `/wiki source add link` or `/wiki source add clone`. Add
`--workspace <directory>` when Pi started from the workspace parent. The
extension owns bounded run history and writes generated pages only under
`wiki/`.

The run has five user-visible stages:

```text
Inspect -> Research -> Plan -> Write -> Verify
             ^  |        |       ^  |      |
             |  + audit -+       |  + fix-+
             + research/replan ---+
```

Research repeats until its evidence and coverage audits reach saturation.
Writing includes a per-page submission gate, and Verify aggregates global
static and semantic defects into repair waves. Directory indexes, OKF v0.2
trust metadata, deletion, and publication are deterministic coordinator or
publisher work. These are bounded operations inside the five stages, not extra
top-level phases.

Read the reference for the assigned role in full:

- [Structured research](references/research.md)
- [Coverage planning and synthesis](references/synthesis.md)
- [Per-page writing and repair](references/write.md)
- [Global semantic review](references/review.md)

Writers receive one skeleton matching their page type: [Overview](references/templates/overview.md),
[Architecture](references/templates/architecture.md), [Module](references/templates/module.md),
[Flow](references/templates/flow.md), or [Concept](references/templates/concept.md).
Use it as structural guidance, never as a fill-in template. Decide actual
sections only after reading authorized source.
