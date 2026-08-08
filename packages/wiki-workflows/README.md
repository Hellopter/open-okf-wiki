# OKF Wiki Workflows

`@okf-wiki/wiki-workflows` turns a local Git repository into a generated
`wiki/` directory using `@quintinshaw/pi-dynamic-workflows`.

```bash
okf-wiki install
```

This registers project-local `/wiki-generate` and `/wiki-refresh` commands in
Pi. Both run in the pi-DW background manager, so `/workflows` provides progress,
pause/resume, and run recovery. Each workflow agent gets one automatic retry for
recoverable execution failures. In an agent detail view, `r` branches the same
run at a selected settled agent: completed prefix calls replay, while that agent
and downstream work execute again. The runs list retains `r` for full-run
restart.

The package reads the current working tree directly. `wiki/` is fully managed,
and Git history is the only refresh baseline and recovery mechanism.

```text
/wiki-generate lang=zh
/wiki-refresh lang=en focus=authentication
```

`okf-wiki inspect` prints the current Git-derived impact report. `okf-wiki
finalize` rebuilds Wiki indexes and validates source citations, internal links,
and Mermaid fences.

## Runtime Boundary

The saved scripts invoke the installed CLI by absolute Node path, so the planner
and finalizer do not depend on a package bin being present on `PATH`. The
finalizer is a dedicated agent that runs `okf-wiki finalize --json` and returns
the command exit code plus JSON; nonzero exits fail the workflow. The finalizer
does not repair pages.

The raw pi-DW workflow API has no host-command step, so `wiki/` write scope is an
agent instruction rather than a host-enforced sandbox.
