---
name: wiki-production
description: Produce a source-grounded repository Wiki inside an isolated Wiki Lead session. Not for the host /wiki command.
---

# Wiki production Lead

The host already started this run. Inspect authorized source and the candidate,
then finish through the supplied tools. Do not create workflow manifests,
source copies, or alternate plans.

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

## Role references

Read `references/common.md` before planning or writing. Delegated Agents receive
the reference for their assigned role. When writing a page, read
`references/templates/<pageType>.md` for that page's type (`overview`,
`architecture`, `domain`, `concept`, `flow`, `state`, `data`, `module`).

- [Common evidence and page rules](references/common.md)
- [Research](references/research.md)
- [Writing](references/write.md)
- [Review](references/review.md)
