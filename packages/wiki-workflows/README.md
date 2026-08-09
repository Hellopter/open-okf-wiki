# OKF Wiki

`@okf-wiki/wiki-workflows` is a Pi extension for Git-native repository Wiki
production. It does not expose a CLI or save generic workflows. A workspace is
a plain directory configured by `workspace.yaml`; each source is an
independent Git project linked or cloned directly into that directory.

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
only a one-run override. `/wiki` is a non-blocking status command. Use
`/wiki open` to explicitly open the dedicated run console; `/wiki status`
prints the current run, `/wiki history` prints a concise project history,
`/wiki pause` and `/wiki resume` control scheduling, and `/wiki cancel` stops
it. Run Pi from the workspace directory when starting or recovering a Wiki run.

The extension owns the Wiki plan/write/review DAG and active Pi-session state.
It also retains the newest 100 terminal, project-scoped execution snapshots
under Pi's agent directory, including bounded Agent output, attempts, and tool
summaries. Pi supplies subagent sessions, automatic context compaction,
provider retry, model selection, and tool execution. The console reports those
runtime events and permits a settled Agent retry or a phase retry without
rerunning valid upstream work. Retrying historical terminal history forks a new
run so the selected record stays immutable.

Planner and reviewer nodes submit DAG-control data through dedicated typed
tools, rather than asking the model to emit JSON in its final text. Research
nodes hand Markdown receipts directly to the writer; writer and repair nodes
make filesystem changes and may finish with a Markdown summary. Static phase
guidance and the receipt example live in the packaged Wiki skill references,
which the workflow injects into isolated child sessions without loading ambient
skills.

Generated pages are always under `wiki/`. Source citations begin with the
declared project directory and include source line ranges, for example
`api/src/index.ts#L12-L38`. Current Git changes are used for a trusted affected
subset; otherwise refresh safely rebuilds the Wiki. The YAML configuration is
not a snapshot, source copy, or run history store; execution history never
contains copied source files or Wiki snapshots.
