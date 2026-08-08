# Open OKF Wiki

Git-native repository Wiki production for Pi dynamic workflows. Source code is
read directly from the current Git workspace; generated pages live only in
`wiki/` and cite paths relative to the workspace root.

Install the Pi dynamic-workflows package, then register this project's commands:

```bash
pnpm --filter @okf-wiki/wiki-workflows build
pnpm --filter @okf-wiki/wiki-workflows exec node dist/cli.js install
```

Pi then provides two background commands backed by `pi-dynamic-workflows`:

```text
/wiki-generate lang=zh
/wiki-refresh lang=zh
```

`/wiki-generate` rebuilds the managed `wiki/` directory. `/wiki-refresh` uses
Git history, the index, and page citations to target changed code; it falls back
to a full regeneration when the existing Wiki cannot be trusted as a baseline.
Use `/workflows` to inspect, pause, resume, or retry one settled agent from its
detail view. The retry replays the completed prefix and reruns its downstream
work. There is no source registry, copied snapshot, approval gate, Wiki-specific
run store, or custom Navigator.

The package requires a local Git repository. `wiki/` is fully generator-managed;
Git remains the only history and rollback mechanism.
