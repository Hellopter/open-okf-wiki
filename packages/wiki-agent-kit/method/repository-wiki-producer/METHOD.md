# Repository Wiki Producer Method

This method pack is copied into every Wiki run as `method/`. It guides the Pi
workflow; users control runs through `/wiki`, not by invoking method files.

## Operating model

One persistent main Agent owns the evolving plan and the final Wiki. It keeps
its working memory on disk in Markdown, then resumes the same session after a
proposal is approved. Small, independent agents are used only for isolated
discovery and review. They do not coordinate through JSON receipts and never
write Wiki pages.

The lifecycle is deliberately small:

1. The host freezes the source snapshots and deterministically creates the inventory.
2. For a large or multi-domain inventory, bounded discovery agents write short Markdown briefs; multi-source runs also get one cross-source integration brief.
3. The main Agent writes `analysis/plan.md` and source-grounded `analysis/evidence/*.md`; an independent critic writes `analysis/coverage-review.md`, then one re-review.
4. The main Agent incorporates valid criticism into the plan. The host either pauses for approval or continues automatically.
5. The same main Agent writes the Wiki. Independent evidence, workflow, navigation, and reader-QA reviewers write their own reports; the main Agent gets one repair and failed-item re-verification pass.
6. The host validates the page matrix, evidence briefs, quality verdicts, Mermaid structure, indexes, provenance, and then seals `bundle/`.

The host owns run state, digests, locks, approval, session persistence, and sealing. An Agent must never
read or write `analysis/state.json`, `analysis/run.lock.json`, `analysis/bundle.manifest.json`, or
`analysis/session/`; it must never write inventory data or provenance fields.

## Run layout

| Path | Role | Writer |
|---|---|---|
| `inputs/` | Frozen inventory, policy, snapshot metadata, and source snapshots | host |
| `inputs/sources/<id>/` | Read-only source evidence | host |
| `method/` | This frozen method pack | host |
| `analysis/state.json` | Control-plane state and digests | host |
| `analysis/run.lock.json` | Active orchestration ownership lock | host |
| `analysis/inventory.md` | Readable deterministic coverage inventory | host |
| `analysis/discovery/sources/<source>.md` | Optional independent source research briefs | discovery Agent |
| `analysis/discovery/integration.md` | Optional cross-source integration brief | integration Agent |
| `analysis/evidence/*.md` | Source-grounded page evidence briefs | evidence researcher |
| `analysis/plan.md` | Authoritative hierarchy, coverage decisions, and writing memory | main Agent |
| `analysis/coverage-review.md` | Independent plan coverage critique | coverage critic |
| `analysis/reviews/coverage-rereview.md` | Final coverage re-review | coverage critic |
| `analysis/reviews/{evidence,workflow,navigation,reader-qa}.md` | Independent completed-bundle quality reports | reviewers |
| `analysis/session/` | Persistent main-Agent session data | host/runtime |
| `bundle/` | Final OKF v0.2 Wiki | main Agent, then host seal |

Never read a mutable registered repository after freeze. Never write under `inputs/`, `method/`, or
`analysis/session/`.

## Markdown handoffs

All semantic handoffs are readable Markdown. Read the smallest relevant artifact when needed; do not
paste discovery briefs or source dumps into later prompts. A tool response may contain a short status,
but it is not an instruction to manufacture a JSON protocol.

- `plan.md` is the main Agent's source of truth after planning. Revise it when scope, evidence, or page
  structure changes.
- Discovery briefs, including the optional cross-source integration brief, contain observations and source citations, not final page assignments.
- Every evidence brief cites frozen source line ranges and is named by a `Page Matrix` row in `plan.md`.
- Critic and reviewer files state concrete omissions or defects with evidence and proposed repairs. Final quality reports use the host-parseable lines `Verdict: PASS|FAIL`, `Affected pages:`, `Findings:`, and `Required repair:`.
- The host records control decisions separately in `state.json`; it is not an Agent handoff document.

## OKF bundle rules

The bundle is a domain and concept hierarchy, not a list of implementation modules:

```text
bundle/
  index.md                         # host generated
  domains/<domain>/index.md        # host generated
  domains/<domain>/overview.md     # domain narrative
  domains/<domain>/<concept>.md    # domain-specific concept
  concepts/<shared-concept>.md     # cross-domain concept or workflow
```

Every authored page has YAML frontmatter with non-empty `type`, `title`, and `sources`. `sources` is a
YAML list of mappings, each with a stable `id` and a run-relative `resource` such as
`inputs/sources/app/src/session.ts#L18-L86`. `description`, `tags`, and `domains` are optional when they
improve navigation. Do not author `generated`; the host stamps it at seal time and supplies `status: draft`
when absent. Do not author any `index.md` or depend on a hand-written table of contents: indexes are
generated after validation.

Use relative Markdown links between pages and source citations with real one-based line ranges. Cite only
frozen content under `inputs/sources/<id>/`; do not invent ranges, cite remote URLs, or use editor links.
All prose follows `wikiLanguage` in `inputs/run-policy.json`; for `zh`, write Simplified Chinese while
leaving paths and identifiers unchanged.

`plan.md` must contain one contiguous `## Page Matrix` table with columns `Page`, `Coverage Units`,
`Evidence Brief`, and `Diagram`. Every generated page maps to a frozen-source-citing brief under
`analysis/evidence/`; every required inventory unit appears in at least one row. `Diagram` is exactly
`required`, `useful`, or `omitted`. Required rows need a Mermaid fence. The host performs conservative
local structural validation of Mermaid fences (including malformed fences and known unsafe syntax); this
is not a browser rendering check.

Read the phase reference in full before starting that phase:

| Phase | Reference |
|---|---|
| Optional discovery | `references/discover.md` |
| Planning | `references/plan.md` |
| Bundle writing and revision | `references/generate.md` |
| Coverage criticism and final review | `references/review.md` |
