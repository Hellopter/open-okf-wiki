# OKF Repository Wiki Profile v1

This kit produces OKF v0.2-compatible concept pages with a stricter project profile.

## Concept pages

Every concept page under `candidate/` (except reserved files) must have YAML frontmatter:

| Field | Rule |
|---|---|
| `type` | Required non-empty string (`Overview`, `Business Process`, `Module`, …) |
| `title` | Required; Chinese when wiki language is zh/zh-CN |
| `description` | Required one-sentence summary for indexes and progressive disclosure |
| `tags` | Optional |
| `generated` | Forbidden for model authors |
| `verified` | Forbidden for model authors |
| `stale_after` | Forbidden for model authors |
| `okf_version` | Forbidden on concept pages |

Host assembly may later add provenance/trust fields. Models must not fake human verification or
timestamps. Host provenance beyond mechanical sealing remains a later iteration (P1/P2).

## Reserved files

- `index.md` — host regenerated only. Root index may declare `okf_version: "0.2"`. Subdirectory
  indexes stay plain reserved listings without frontmatter.
- `log.md` — host/publish owned; writers never author it in this kit.

## Citations and sources

Body claims use local relative Markdown links into frozen `sources/<id>/` with real one-based line
ranges. Do not use `repo:`, remote URLs, `file://`, or editor URLs. Relative links between concept
pages must resolve inside `candidate/`.

## Page types used by this profile

Overview, Business Domain, Business Process, Data Model, Module, Architecture, Concept, Known Gap,
and other Spec-declared types as needed. Planner chooses types from reader questions and evidence,
not from a fixed page-count target.
