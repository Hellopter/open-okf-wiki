# Generate and Revise

Write the approved Wiki into `bundle/` using `analysis/plan.md` as the authority. This is one continuous
main-Agent task: do not divide pages into owner shards, reconstruct a new plan, or create an artifact list.

## Before writing

1. Read the full plan, relevant discovery briefs, and `analysis/coverage-review.md` when it exists.
2. Re-open the load-bearing spans in `inputs/sources/<id>/`. A discovery brief is a lead, not proof.
3. Read `inputs/run-policy.json` and keep all human-facing prose in its `wikiLanguage`.

## Write the hierarchy

- Write domain narratives at `bundle/domains/<domain>/overview.md` and domain-specific concepts alongside
  them. Put a concept or workflow that genuinely crosses domains in `bundle/concepts/` and link to all
  participating domains.
- Create pages only when they have a distinct reader question in the plan. Merge thin implementation
  details into the domain or concept that makes them understandable.
- Never write `index.md`; validation generates the root and directory indexes. Never write `log.md`.
- Use relative `.md` links for internal navigation. Links must resolve within `bundle/`.

## Frontmatter and evidence

Every authored page starts with YAML frontmatter:

```yaml
---
type: concept
title: Authentication lifecycle
sources:
  - id: app-session
    resource: inputs/sources/app/src/auth/session.ts#L18-L86
domains: [identity]
---
```

`type`, `title`, and `sources` are required and must be non-empty. Every source entry needs a stable `id`
and a `resource` under `inputs/sources/` with a real line fragment. `description`, `tags`, and `domains`
are optional. Do not write `generated`; the host adds provenance when it seals the bundle. Do not claim
that a page is verified.

Support factual prose with nearby links to real frozen source lines, for example:

```md
The session is renewed only after the token check succeeds.
[Source: session renewal](../../inputs/sources/app/src/auth/session.ts#L42-L68)
```

Choose paths relative to the authored page. Never cite a mutable checkout, an external URL, `file://`,
or an editor URI. Do not estimate line ranges.

## Revision after review

The reviewer writes `analysis/review.md` without changing the bundle. Read every finding, verify it
against the plan and frozen source, and repair concrete defects in the existing pages. Update `plan.md`
only when the review changes scope or coverage reasoning. Do not write a repair receipt or begin an
unbounded review loop; one targeted revision pass is part of this run, after which the host validates.
