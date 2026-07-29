---
name: repository-wiki-producer
description: Produce or refresh a source-grounded Wiki from a pinned Repository Snapshot Set.
---

# Repository Wiki Producer

## Run workdir layout

The agent cwd is a **run workdir**. All tool paths are relative to it:

| Path | Role |
|------|------|
| `sources/<id>/` | Repository Snapshot mounts (read-only). One source → one mount id. |
| `skill/` | This Producer Skill (read-only). Start with `skill/SKILL.md`. |
| `wiki/` | Staging Wiki (writable in write roles). |
| `analysis/` | Run analysis (`analysis/spec.json`, receipts; writable in write roles). |

## Pi tools

Use only Pi built-in tools (no shell / bash):

| Tool | Use |
|------|-----|
| `ls` | List a directory under the run workdir |
| `find` | Find files by name/glob (e.g. under `sources/<id>/`) |
| `grep` | Content search; results include 1-based line numbers |
| `read` | Read file contents (offset/limit for large files) |
| `write` | Create/overwrite files under `wiki/` or `analysis/` only |
| `edit` | Surgical edits under `wiki/` or `analysis/` only |

Do **not** invent Host tool names (`list_source`, `read_source`, `write_wiki`, `publish_receipt`, …).
Path guards reject writes outside `wiki/` and `analysis/`, and apply Effective Source Ignores under
`sources/`. The Operator Agent selects `wiki_produce` **only** when the operator explicitly asks to
produce, build, regenerate, refresh, or rewrite the Wiki — not for model/context/token questions,
settings, source management, greetings, or general Q&A. Inside a Wiki Run, use only the Pi tools
above.

## Semantic loop (job index)

The Root Agent owns this loop and advances only when the current completion gate holds. Maintain a
living **WikiRunSpec** under `analysis/` (e.g. `analysis/spec.json`) via `read` / `write` when those
tools are available. On large or multi-domain scopes, Root opens the bounded Domain → Leaf research
branch; children investigate and return evidence summaries, while Root keeps Spec synthesis, Wiki
writing, and repair after independent review. Return to an earlier step whenever later evidence
breaks its gate. Review always runs and **fails the run** if blocking defects remain after repair
rounds.

Read each phase reference **in full** before doing that phase's work. Do not invent extra method
layers beyond this index.

| Phase | When | Reference |
|-------|------|-----------|
| **Plan** | Always — shape Spec / page set before write | `skill/references/plan.md` |
| **Generate** | `wiki/` is empty (or fixture-seeded empty) | `skill/references/generate.md` |
| **Refresh** | `wiki/` already has prior pages | `skill/references/refresh.md` |
| **Domain research** | Large or multi-domain scopes need isolated evidence | `skill/references/domain-research.md` |
| **Leaf research** | Under a Domain parent for one narrow subtask | `skill/references/leaf-research.md` |
| **Review** | Always after write (and after each repair round) | `skill/references/review.md` |

### Phase order

1. **Plan.** Read `skill/references/plan.md`. Inspect `sources/`, maintain the living Spec, and
   decide whether Domain/Leaf research is needed. **Gate:** every intended page has a clear reader
   purpose and enough inspected evidence to write.
2. **Choose write branch.** Inspect `wiki/` with `ls` / `read`. Read `skill/references/generate.md`
   when it is empty; otherwise read `skill/references/refresh.md`. **Gate:** the selected branch
   reference has been read in full before write work begins.
3. **Optional research branch.** When plan opened Domains/Leaves, follow
   `skill/references/domain-research.md` and `skill/references/leaf-research.md`. Children return
   evidence only; Root synthesizes Spec + receipts and re-opens load-bearing source spans. Do not
   call Reviewer until staged Wiki pages exist.
4. **Write the Wiki.** Select only relevant files from
   `skill/templates/{overview,architecture,module,flow,concept}.md`, read them in full, and adapt
   them while writing final Markdown concept pages under `wiki/` with `write` / `edit` (prefer
   directories such as `modules/`, `flows/`). Do not treat `index.md` as writer work — the product
   regenerates directory listings mechanically. Place verified Source Citations beside the facts
   they support. **Gate:** every intended concept page exists, answers its reader question, links
   to related pages where useful, and is grounded by nearby verified Source Citations.
5. **Review and finish.** Read `skill/references/review.md`. Treat Reviewer defects as blocking:
   repair each issue, returning to earlier steps when page scope or evidence changes. Do not claim
   completion while blocking defects remain — the run fails if review is unclean after repair
   rounds. A partial, failed, or cancelled critical branch may be retried only within the Run
   Boundary budget; if direct fallback research cannot complete it, fail the Wiki Run and preserve
   the previous Published Wiki. Internal child or budget failure is not Needs Input. Then return
   the exact Markdown page manifest. **Gate:** every review check passes, every critical planned
   scope is complete, every non-critical cancellation is explicit in the Spec, and the manifest
   exactly matches the final page tree.

## Core output contract

### Concept pages (all `.md` except reserved names)

Begin every **concept** page with YAML frontmatter containing non-empty **`type`**, **`title`**, and
a one-sentence **`description`** (OKF v0.2 + product UI). Optional `tags` (short lowercase strings)
help cross-cutting navigation. Suggested `type` values: `Overview`, `Architecture`, `Module`,
`Flow`, `Concept`. Keep internal Wiki links relative and ending in `.md`.

```yaml
---
type: Module
title: Session runtime
description: How operator sessions are created, resumed, and streamed.
tags: [session, runtime]
---
```

Do **not** write `generated`, `verified`, `stale_after`, or `okf_version` frontmatter — the Run
Boundary stamps these provenance fields mechanically at publication; model-authored timestamps or
verification claims would be fabrications.

For one repository, write Source Citations as
`[Source](repo:path/to/file.py#L10-L20)`. For multiple repositories, prefix the path with the
repository ID: `[Source](repo:repository-id/path/to/file.py#L10-L20)`. Use repository-relative POSIX
paths and one-based inclusive line ranges. **Tool path → cite form:** transform `sources/<id>/rest`
to single `repo:rest` or multi `repo:<id>/rest` — never leave a `sources/` prefix inside `repo:`.
Line numbers must come from `read` or `grep` results — never invent or estimate ranges.

### Reserved files (OKF)

| File | Role |
|------|------|
| `index.md` (every directory) | Progressive-disclosure **listing only** for that directory's concept pages and child directories. No concept frontmatter; no Source Citations required. **The product mechanically regenerates every directory `index.md` after write/repair and again on the publish candidate.** Agents must **not** treat hand-written TOC as durable authority and must not treat writing indexes as a completion criterion. |
| `log.md` | Optional change history (newest first). |

Narrative entry is **`overview.md`** (or the Spec path) — **not** `index.md`. Organize related concepts in directories (`modules/`, `flows/`, deeper as needed) so hierarchy lives in the directory layout Spec/Writer owns. Spec pages must **not** include `index.md` or `log.md`.

### Research receipts

Domain/Leaf research is orchestrated by produce: child sessions return evidence summaries; the
runtime persists bounded Analysis Receipts under `analysis/receipts/*.json`. Root writer synthesizes
from Spec + receipts and re-opens load-bearing source spans; never treat a child summary alone as
proof.

Return Needs Input only when missing external information makes a trustworthy Wiki impossible;
resolve routine uncertainty by continuing the semantic loop.
