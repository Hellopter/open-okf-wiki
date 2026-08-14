---
name: repository-wiki-producer
description: Produce or refresh a source-grounded repository Wiki from the current Git repository or an existing multi-source workspace.
---

# Repository Wiki Producer

Use `/wiki [focus]` to update the Wiki and `/wiki regenerate [focus]` to rebuild
its page topology. A Git repository without `workspace.yaml` is an implicit
single source. Existing multi-source workspaces use their declared sources.

For an explicit multi-source workspace, use `/wiki init [workspace]` followed
by `/wiki source add link <local-git-root>` or `/wiki source add clone <url>`.
Links are symlinks on Linux/macOS and directory junctions on Windows. The link
target must be a Git repository root; use clone when linking is unsuitable.

The host owns run state, source fingerprints, path authorization, validation,
and publication. Do not create workflow manifests, source copies, or alternate
plans. Work only through the tools and paths supplied for the current run.

The Lead follows a normal tool loop:

1. Inspect source and the existing candidate with `read`, `grep`, `find`, and
   `ls`.
2. Submit the complete versioned topology with `wiki_plan`. Use one top-level
   directory per domain, with `domain.md` and evidence-driven `concepts/`,
   `flows/`, `states/`, `data/`, or `modules/` pages. Flow pages contain any
   sequence diagrams.

   WikiSpec pages and written pages are different contracts:

   - Spec page: `pageType`, `path`, `title`, `purpose`, `readerQuestions`,
     `requiredFacets`, `findingIds`
   - Overview is an object at `overview.md`; one top-level dir per domain with
     `domain.md`
   - Written page frontmatter is a different contract: `type`, `title`,
     `description`, `sources`

3. Write directly only when the accepted plan has exactly one domain and at
   most three content pages. After context compaction, always delegate writing.
4. For independent or context-heavy work, call `wiki_delegate` with bounded
   research, write, or review tasks.
5. Read delegated Markdown artifacts by reference; treat failed or incomplete
   receipts as missing coverage, never as evidence of absence.
6. Delegate independent review of every current Spec page. Reviewers call
   `wiki_review_finish` with a structured verdict; any write or plan revision
   invalidates prior passes.
7. Call `wiki_finish` only after every current page has passing review coverage.

Research and review tasks write concise Markdown artifacts with precise
`path#Lx-Ly` evidence. Writer tasks edit only their authorized candidate paths.
Candidate writes are validated before replacement using the bundled YAML parser;
there is no external `yamlformatter` dependency. Directory `index.md` files are
owned and generated deterministically by the host, never by an Agent.
JSON is a small control envelope, not a prose handoff format.

Read the reference for the assigned role:

- [Common evidence and page rules](references/common.md)
- [Research](references/research.md)
- [Writing](references/write.md)
- [Review](references/review.md)
