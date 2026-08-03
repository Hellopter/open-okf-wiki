# Overview template

Adapt this into **`overview.md`** (concept page). Frontmatter example:

```yaml
---
type: Overview
title: Repository name
description: One sentence on what the repository does and for whom.
---
```

`index.md` is a reserved mechanical listing (product-regenerated) — not this narrative.

- What the repository (or multi-source product) does and for whom
- The smallest useful mental model
- Main capabilities and boundaries
- **Repository / surface map** when the freeze has multiple sources or monorepo packages: what each
  owns and how they compose (do not narrate only the first README you opened)
- Links to the pages this Wiki actually needs
- Source Citations beside factual explanations

Open with the product's value rather than its directory tree. For multi-source runs, ground claims
with `repo:<id>/…` citations. Omit irrelevant prompts and merge small topics into the narrative.
