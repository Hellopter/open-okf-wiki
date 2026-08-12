# Repository Wiki Producer

`@okf-wiki/wiki-workflows` is a Pi extension that produces source-grounded
repository Wikis. It does not expose a CLI or persist generic workflows. A
workspace is a plain directory configured by `workspace.yaml`; each source is
an independent Git project linked or cloned into that directory.

```bash
pnpm build
pi install ./packages/wiki-workflows
```

Initialize once with `/wiki init --lang zh` (or `en`), then add sources with
`/wiki source add link <local-repository>` or
`/wiki source add clone <git-url> [--ref <branch>]`. Add
`--workspace <directory>` to either command when initialization was performed
from a parent directory. The project directory name is the source identity,
with no `id` alias. `/wiki generate` uses the saved language; `lang=zh|en` is
only a one-run override. `/wiki` shows command help without blocking. Use
`/wiki open` to explicitly open the dedicated run console; `/wiki status`
prints the current run, `/wiki history` prints a concise project history.
Scheduling controls:

| Action | Behavior |
|--------|----------|
| `/wiki pause` | Soft pause: no new scheduling; active agents may finish |
| `/wiki stop` | Hard stop: abort agents, requeue them, pause (resumable) |
| `/wiki resume [runId]` | Resume a paused run after Git re-inspection |
| `/wiki cancel` | Abort agents; terminal cancelled (not resumable) |

Run Pi from the workspace directory when starting or recovering a Wiki run.

On Pi session shutdown, active Agents are interrupted back to queued state and
the run is persisted as paused to both the current Pi session branch and the
project-scoped history. Pi's `/resume` restores the snapshot from that exact
branch; `/wiki resume` then re-inspects Git before dispatch. A fresh Pi session
can explicitly run `/wiki resume` to recover the most recently updated
`running` or `paused` project run, or `/wiki resume <runId>` to select one.
Another active run is never overwritten. `failed` and `blocked` records require
an Agent (`r`) or phase (`R`) retry, while `succeeded` and `cancelled` records
cannot be resumed.

The extension owns the Wiki-specific dynamic DAG and active Pi-session state.
Durable runs live under `.okf-wiki/runs/<runId>/`, with `run.json` as the
authoritative snapshot and a rebuildable summary index. History is bounded to
the newest 100 terminal runs. Pi supplies isolated subagent sessions, automatic
context compaction, provider retry, model selection, and tool execution.
Retrying terminal history forks a new run so the selected record stays
immutable.

The user-visible workflow is
`Inspect -> Research -> Plan -> Write -> Review & Publish`.
Research starts one fresh agent per declared source. When receipts report no
unresolved critical gaps, Plan must finalize and the engine skips forced dry
audits, going straight to writers. Expand is hard-rejected without critical
gaps; with gaps, Plan may request a targeted batch of at most four scopes.
Planning emits a complete target WikiSpec in both generate and refresh modes.
Every non-overview domain has one required `<domain-id>/domain.md` aggregation
page plus evidence-driven architecture, flow, concept, state, data, or module
pages. Each page declares reader questions and required facets. The default
run-wide agent limit is two and can be configured from one to four. A fresh
Overview writer runs after all content pages complete.

Session restore is pointer-only (no legacy full-snapshot dual-read). Research,
planning, and review submit typed objects directly; accepted objects are
content-addressed under `.okf-wiki/blobs/{sha256}.json`. Durable snapshots use
`version: 10` and pin the resolved policy and hash. Older session entries,
history files, and artifact layouts are
**not migrated** — after upgrading, delete stale `.okf-wiki/` under the
workspace, then run `/wiki generate` again.

Write performs deterministic format, citation, link, and Mermaid validation and
repairs immediately. Only a clean candidate advances to semantic review.
Page-local evidence, link, depth, and diagram defects return to a fresh writer;
topology or coverage defects can trigger one full structural replan. Each Plan
version permits at most three repair rounds. Repeated normalized issues,
repeated defects, unchanged repaired pages, or exhausted budgets block the run.
Source state is checked again before completion: the first drift restarts from
Inspect and the second blocks with evidence.

Research receipts are bounded Markdown evidence indexes. The engine derives a
minimal WikiPagePacket for each writer from the Spec, selected receipts,
authorized source roots, relevant cross-links, shared terms, exact Wiki read
paths, and one write path. Writers re-open source before citing it and never
receive the complete synthesis or review artifact. Agents cannot delete pages.
Writers and reviewers operate on
`.okf-wiki/runs/<runId>/candidate/wiki`; published `wiki/` is unchanged during
the run. Refresh retains unchanged Markdown, while generate starts a clean
Markdown projection and preserves assets. After review, the publisher rechecks
source drift, finalizes the candidate, and atomically swaps it into `wiki/`
using a recoverable journal. Startup recovers interrupted publication before
restoring a run.

The packaged skill is named `repository-wiki-producer`. Its references contain
role-specific prompts and optional Overview/Domain/Architecture/Module/Flow/
Concept/State/Data skeletons. Writers choose sections, citations, and useful
Mermaid diagrams only after reading verified source.

Generated pages are always under `wiki/`. Source citations begin with the
declared project directory and include source line ranges, for example
`api/src/index.ts#L12-L38`. Current Git changes are used for a trusted affected
subset; otherwise refresh safely rebuilds the Wiki. Defaults are written by
`/wiki init` and can be overridden explicitly:

```yaml
quality:
  maxResearchRounds: 6
  maxSubmissionAttempts: 3
wiki:
  exclude: [api/generated/**]
  terminology:
    Ledger: Canonical accounting record
  domains:
    - id: billing
      title: Billing
      include: [api/src/billing/**]
      exclude: [api/generated/**]
  runtime:
    maxConcurrentAgents: 2
    nodeTimeoutSeconds: 1200
    maxTransientSessionAttempts: 2
    rateLimitCooldownSeconds: 15
```

Configuration fields and defaults:

| Field | Default / range | Semantics |
|-------|-----------------|-----------|
| `quality.maxResearchRounds` | `6`; integer `3..20` | Combined per-run research-round ceiling; fixed at run start |
| `quality.maxSubmissionAttempts` | `3`; integer `1..3` | Direct typed submission calls allowed in one node attempt |
| `wiki.exclude` | `[]` | Source-relative or project-prefixed globs removed from inspection and rejected as accepted evidence |
| `wiki.terminology` | `{}` | Non-empty canonical term-to-definition strings injected into Plan, writers, and review |
| `wiki.domains` | `[]` | Required domain identities and research boundaries; ids are unique safe identifiers |
| `wiki.domains[].id` | required | Exact final WikiSpec domain id and `<id>/domain.md` directory |
| `wiki.domains[].title` | required | Exact final WikiSpec domain title |
| `wiki.domains[].include` | required, non-empty | Research scope patterns whose first path component must be a declared source |
| `wiki.domains[].exclude` | `[]` | Domain-specific research boundary supplied to that domain's research task; use `wiki.exclude` for global deterministic evidence rejection |
| `wiki.runtime.maxConcurrentAgents` | `2`; integer `1..4` | Shared engine and Pi-session admission limit; may be reduced temporarily by 429 or memory pressure |
| `wiki.runtime.nodeTimeoutSeconds` | `1200`; integer `60..1800` | Wall-clock deadline for one isolated node session |
| `wiki.runtime.maxTransientSessionAttempts` | `2`; integer `1..2` | Total fresh sessions for context, deadline, or exhausted transient-provider failure classes |
| `wiki.runtime.rateLimitCooldownSeconds` | `15`; integer `15..120` | Admission cooldown after 429/rate-limit pressure |

`/wiki init` writes these defaults. When `wiki` is omitted from an otherwise
valid workspace, loading resolves the same defaults. A new run normalizes the
current values, adds the prompt-bundle identity, and pins both policy and hash
in snapshot version 10. Editing `workspace.yaml` does not hot-update executing
agents. On `/wiki resume`, a paused run compares the current policy hash; if it
changed, the run pins the new policy, invalidates downstream nodes, and starts
again at Inspect. `quality.maxResearchRounds` is not reconciled into an
existing run; `quality.maxSubmissionAttempts` is part of the pinned policy.

Configured domains fail closed when include patterns do not match a declared
source. Global excluded paths cannot become accepted citation evidence.

## Attempts, Retry, and Cost Bounds

The durable `node.attempt` counter is a fresh Pi session count, not a provider
request count. Context overflow, the configured node deadline, and exhausted
transient-provider failures use `maxTransientSessionAttempts`: the default `2`
means one automatic fresh-session retry, while `1` disables it.
Validator-infrastructure failures may use the internal maximum of three node
sessions.

Each session enables Pi auto-retry with a hard `maxRetries: 3`, a 2-second base
delay, and provider-library retries set to zero. Thus one Pi model request has
at most four provider attempts: one initial attempt plus three retries. For a
primary node request, two fresh sessions can therefore expose up to eight
attempts, while the three-session validator-infrastructure path can expose up
to twelve. This is a retry-multiplication ceiling for the primary request, not
a complete billing bound: a missing submission may add one same-session
correction turn, tool continuations are additional model requests, and every
such request has its own Pi retry allowance. Structured submission tools allow
the configured `1..3` submission calls per node attempt (default `3`); those
calls do not increment
`node.attempt`. The Pi inner retry ceiling is fixed; fresh-session count,
deadline, cooldown, and submission count are the bounded settings above.
