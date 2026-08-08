# OKF Wiki

`@okf-wiki/wiki-workflows` is a Pi extension for Git-native repository Wiki
production. It does not expose a CLI or save generic workflows.

```bash
pnpm build
pi install ./packages/wiki-workflows
```

Use `/wiki generate [lang=zh|en]` to create a Wiki and `/wiki refresh` to
refresh it from current Git changes. `/wiki` opens the dedicated run console;
`/wiki status` prints the current run, `/wiki pause` and `/wiki resume` control
scheduling, and `/wiki cancel` stops it.

The extension owns the Wiki plan/write/review DAG and Pi-session run state.
Pi supplies subagent sessions, automatic context compaction, provider retry,
model selection, and tool execution. The console reports those runtime events
and permits targeted retry of a settled node without rerunning valid upstream
work.

Generated pages are always under `wiki/`. Source citations are relative to the
workspace root and include source line ranges. Git history is the only refresh
baseline and rollback mechanism.
