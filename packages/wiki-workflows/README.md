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
prints the current run, `/wiki history` prints a concise project history,
`/wiki pause` and `/wiki resume [runId]` control scheduling, and `/wiki cancel`
stops it. Run Pi from the workspace directory when starting or recovering a
Wiki run.

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
It also retains the newest 100 terminal, project-scoped execution snapshots
under Pi's agent directory, including bounded Agent output, attempts, and tool
summaries. History writes are serialized, awaited during shutdown, and report
write failures through Pi. Pi supplies subagent sessions, automatic context compaction,
provider retry, model selection, and tool execution. The console reports those
runtime events and permits a settled Agent retry or a phase retry without
rerunning valid upstream work. Retrying historical terminal history forks a new
run so the selected record stays immutable.

The user-visible workflow is `Inspect -> Research -> Plan -> Write -> Verify`.
Research starts one fresh agent per declared source. When receipts report no
unresolved critical gaps, Plan must finalize and the engine skips forced dry
audits, going straight to writers. Expand is hard-rejected without critical
gaps; with gaps, Plan may request a targeted batch of at most four scopes.
Planning emits a complete target WikiSpec in both generate and refresh modes.
Every content page is written by a fresh agent with a per-page evidence scope,
with at most four writers active at once. A fresh Overview writer runs after all
content pages in the round complete and reads the full target page set.

Session restore is pointer-only (no legacy full-snapshot dual-read). Agent
handoffs are content-addressed under `.okf-wiki/blobs/{sha256}.json` with
per-run staging and manifests under `.okf-wiki/runs/`. Durable snapshots use
`version: 8`. Older session entries, history files, and artifact layouts are
**not migrated** — after upgrading, delete stale `.okf-wiki/` under the
workspace and old project history under Pi's agent dir, then run
`/wiki generate` again.

Verify combines pure static validation with one independent semantic reviewer.
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
After review succeeds, the deterministic finalizer revalidates the candidate,
removes only obsolete Markdown, rebuilds `index.md`, preserves assets, and
asserts that the final non-index page set exactly matches the Spec.

The packaged skill is named `repository-wiki-producer`. Its references contain
role-specific prompts and optional Overview/Architecture/Module/Flow/Concept
skeletons. Writers choose sections, citations, and useful Mermaid diagrams only
after reading verified source.

Generated pages are always under `wiki/`. Source citations begin with the
declared project directory and include source line ranges, for example
`api/src/index.ts#L12-L38`. Current Git changes are used for a trusted affected
subset; otherwise refresh safely rebuilds the Wiki. The YAML configuration is
not a snapshot, source copy, or run history store; execution history never
contains copied source files or Wiki snapshots.
