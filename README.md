# Open OKF Wiki

Git-native repository Wiki production as a Pi extension. A Wiki workspace is
a plain directory with `workspace.yaml`, one or more linked or cloned Git
projects at its root, and generated documentation only under `wiki/`.

## Install

Requires Node.js `>=22.19.0` and Pi.

```bash
pnpm install
pnpm build
pi install ./packages/wiki-workflows
```

The package has no CLI, saved workflow, installer command, source copy, or
repository snapshot. `pi install` installs the local package into Pi's global
extension set.

## Workspace Setup

The workspace itself does not need to be a Git repository. Initialize it once
with its persistent Wiki language, then add Git projects. A project keeps its
directory name as its identity; there is no separate source ID or alias.

```text
/wiki init --workspace docs --lang zh
/wiki source add link ../api --workspace docs
/wiki source add clone https://github.com/example/web.git --ref main --workspace docs
```

After setup, start Pi with `docs` as its current directory before running
`/wiki generate`, `/wiki refresh`, or `/wiki open`. One Pi session owns one
active Wiki run. Completed and interrupted run records are also retained per
workspace across Pi sessions.

On Windows, local sources use a directory junction where possible, avoiding
the symlink privilege requirement. UNC paths fall back to a directory symlink
and report an actionable error when Developer Mode or elevation is required.

`workspace.yaml` is the only workspace configuration:

```yaml
version: 1
language: zh
defaultSourceIgnores: true
quality:
  maxResearchRounds: 6
  maxSubmissionAttempts: 3
wiki:
  exclude: []
  terminology: {}
  domains: []
  runtime:
    maxConcurrentAgents: 2
    nodeTimeoutSeconds: 1200
    maxAutoRetries: 3
    maxTransientSessionAttempts: 2
    rateLimitCooldownSeconds: 15
sources:
  - path: api
    origin:
      type: link
      localPath: /absolute/path/to/api
```

It stores declared source locations, the default language, research budget,
and Wiki policy. `wiki.exclude` contains source-relative or project-prefixed
glob patterns that inspection and accepted evidence must exclude.
`wiki.terminology` defines canonical term-to-definition pairs for planning and
review. Optional configured domains require a unique safe `id`, non-empty
`title`, and at least one `include` pattern; `exclude` refines that domain's
research boundary. Include patterns must start at a declared source root.
`wiki.runtime.maxConcurrentAgents` defaults to `2` and accepts integers `1..4`.
`quality.maxResearchRounds` defaults to `6` and accepts integers `3..20`.
`quality.maxSubmissionAttempts` defaults to `3` and accepts `1..3` direct
typed submissions per node attempt. Runtime settings are:

| Field | Default / range | What it controls |
|-------|-----------------|------------------|
| `wiki.runtime.maxConcurrentAgents` | `2`; `1..4` | Concurrent child sessions; temporarily reduced to one under 429 or memory pressure |
| `wiki.runtime.nodeTimeoutSeconds` | `1200`; `60..1800` | Hard deadline for one child session, including retry waits |
| `wiki.runtime.maxAutoRetries` | `3`; `1..16` | Pi agent-level retries after a retryable model-request failure; excludes the initial attempt |
| `wiki.runtime.maxTransientSessionAttempts` | `2`; `1..2` | Total fresh sessions for context overflow, deadline, or exhausted transient failures; `2` means one replacement session |
| `wiki.runtime.rateLimitCooldownSeconds` | `15`; `15..120` | Minimum period during which new work is admitted serially after 429 pressure; not the retry sleep |

Pi 0.82.1 uses pure exponential backoff for `maxAutoRetries`:
`delay(n) = 2s * 2^(n-1)`, without jitter or an agent-level delay cap. The
first waits are 2s, 4s, 8s, and 16s. Retry 16 waits 65,536s; all 16 waits total
131,070s (about 36.4 hours). The node deadline includes those waits, so the
default 1,200-second deadline normally stops a continuously failing session
before it reaches retry 16.

Provider-library retries stay disabled (`provider.maxRetries: 0`). Their
60-second `maxRetryDelayMs` does not cap Pi's agent-level backoff. Authentication,
billing, quota, forbidden, and invalid-request failures are not transient.
After Pi exhausts its retry budget, the workflow can start a replacement
session according to `maxTransientSessionAttempts`.

New runs resolve the current configuration into a normalized policy and pin its
hash in the run snapshot. Editing `workspace.yaml` never hot-patches agents
that are already running. Resuming a paused run compares the policy hash; when
it changed, the run pins the new policy, invalidates downstream work, and
restarts from Inspect. `quality.maxResearchRounds` is fixed when a run starts.
The file never stores source snapshots or copied inputs; durable run state lives
under `.okf-wiki/`.

## Workflow

Every run uses five user-visible stages:

```text
Inspect -> Research -> Plan -> Write -> Review & Publish
```

Research uses a fresh agent per source and may run one bounded targeted batch.
Plan produces the complete target page topology. Write starts one fresh agent
per content page with at most four active writers, then starts a fresh Overview
writer after the content-page barrier. In refresh mode only impacted or new
content pages plus Overview are rewritten unless a structural replan requires a
full rewrite.

Write performs deterministic format, citation, link, and Mermaid validation as
soon as a page is submitted, so the same writer can repair it immediately. A
clean candidate then advances to an independent semantic reviewer.
Page-local defects return to fresh page writers; topology or coverage defects
return to one bounded structural replan. Only after review succeeds does a
deterministic finalizer remove obsolete Markdown, rebuild indexes, preserve
non-Markdown assets, and assert that the final page set exactly matches the
Spec. Agents never delete pages.

The packaged producer skill is `repository-wiki-producer`; its role references
keep research, planning, page writing, and review prompts separate.

## Commands

```text
/wiki
/wiki open
/wiki generate [lang=zh|en] [focus]
/wiki refresh [lang=zh|en] [focus]
/wiki status
/wiki history
/wiki pause
/wiki stop
/wiki resume [runId]
/wiki cancel
/wiki init [--workspace <directory>] [--lang zh|en]
/wiki source add link <local-repository> [--workspace <directory>]
/wiki source add clone <git-url> [--ref <branch>] [--workspace <directory>]
```

| Action | Behavior |
|--------|----------|
| `pause` | Soft: no new scheduling; active agents may finish |
| `stop` | Hard: abort agents, requeue, pause (resumable) |
| `resume` | Continue a paused run after Git re-inspection |
| `cancel` | Abort; terminal cancelled (not resumable) |

`generate` rebuilds the managed Wiki in the language saved by `/wiki init`.
`lang=zh|en` remains an explicit one-run override. `refresh` uses current
staged, unstaged, and untracked changes from declared Git projects plus page
citations to find an affected subset. Independent source repositories have no
shared generation baseline, so it falls back to a full rebuild whenever that
incremental range cannot be trusted.

`/wiki` shows command help and `/wiki status` returns the current run status;
`/wiki history` returns a concise project history. `/wiki open` explicitly
opens the run console, whose root view selects live and historical runs. It
shows phase and Agent state, compact tool targets and result summaries, token
and context figures, validation failures, and Pi compaction and retry activity.
Enter an Agent detail to reveal its retained raw tool payloads only when needed.

Stopping Pi or switching sessions interrupts an active run safely: running
Agents are returned to the queue, the run becomes paused, and the same snapshot
is written to the current Pi session branch and project history before shutdown
finishes. Returning with Pi's `/resume` restores only that branch's Wiki state;
run `/wiki resume` to re-inspect Git and continue scheduling. In a fresh Pi
session, `/wiki resume` restores the most recently updated `running` or `paused`
run for the workspace, while `/wiki resume <runId>` selects an exact record.
An existing active run is never overwritten.

Retrying one settled Agent retains valid upstream results and invalidates its
downstream work. `R` on a settled phase retries its Agents together and is
refused while that phase has a running Agent. Retrying a historical terminal
run creates a new branch run; the selected history remains immutable.
Non-current completed history can be deleted from the console, while the newest
100 terminal runs are otherwise retained.

`failed` and `blocked` runs are terminal and cannot be resumed. Open the run and
use `r` for a settled Agent or `R` for a phase; the retry forks historical
terminal state when necessary. `succeeded` and `cancelled` runs are also not
resumable.

## Guarantees

- Each declared source Git repository is the only source history and rollback
  mechanism.
- All generated pages live below `wiki/`; each writer is restricted to one
  assigned page and explicitly authorized source and Wiki reads.
- Source references begin with the declared project directory, for example
  `api/src/server.ts#L12-L38`; body citations use
  `repo:api/src/server.ts#L12-L38`.
- Pi session custom entries contain only run pointers. Authoritative run
  snapshots, candidate Wiki trees, journals, and handoff manifests are stored
  below `.okf-wiki/`; accepted handoffs use content-addressed blobs. Published
  `wiki/` remains unchanged until recoverable directory publication succeeds.
- Project-history writes are serialized and shutdown waits for the final write;
  persistence failures are reported in Pi instead of being silently ignored.
- Pi's own auto-compaction and provider retry capabilities are enabled for
  subagents; the console reports their activity without reimplementing them.

One missing required submission can add one correction turn in the same
session. Direct structured validation accepts
`quality.maxSubmissionAttempts` (`1..3`, default `3`) tool submissions per node
attempt. Correction turns and tool continuations are separate model requests,
and each can receive its own `maxAutoRetries` budget. Treat these settings as
availability ceilings, not as a billing-call count.
