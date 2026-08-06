# Chinese Writing Contract

When `inputs/run-policy.json` sets `wikiLanguage` to `zh` or `zh-CN`, all reader-facing Wiki prose
is Simplified Chinese. This is a fail-closed contract enforced by review and host validation.

## Required Chinese surfaces

- concept `title` and `description`
- body prose, table headers, figure captions, and callouts
- Spec `question` text and section titles intended for readers
- host-generated index headings in Chinese workspaces

## Must remain untranslated

- class/function/package identifiers
- API paths, HTTP methods, message topics
- config keys, env vars, file paths, module coordinates
- commit shas, digests, and evidence ids
- code samples and fenced blocks

First mention of a business term that has a stable code name uses:

```text
业务术语（CodeIdentifier）
```

Later mentions may use either form when unambiguous.

## Style rules

- Lead with business meaning, then point to code/evidence.
- Prefer precise verbs over marketing filler (“强大”, “易扩展”, “一站式” without evidence).
- Use evidence tone for uncertainty: “源码显示…”, “文档声称…”, “当前快照无法证明…”.
- Keep terminology consistent across pages; do not freely retranslate the same domain noun.
- Do not author timestamps, `generated`, `verified`, or human-review claims.

## Mechanical expectation

Host validation for Chinese runs requires CJK characters in non-empty `title`/`description` and
meaningful CJK in the prose body after ignoring fenced/inline code and bare links. English-only
pages fail closed under a Chinese policy.
