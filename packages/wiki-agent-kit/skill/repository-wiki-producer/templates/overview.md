# Overview template

Adapt this into **`overview.md`**. Frontmatter example:

```yaml
---
type: Overview
title: 仓库名称
description: 一句话说明仓库为谁解决什么问题。
---
```

`index.md` is a reserved mechanical listing (host-regenerated) — not this narrative.

## Required sections

### 业务目标

- What the repository/product does and for whom

### 最小心智模型

- Smallest useful map of domains, flows, and runtime shape

### 能力与边界

- Main capabilities and explicit non-goals

### 仓库与表面地图

- Required when multiple sources or monorepo packages exist

### 阅读路径

- Ordered links to the pages a new engineer or LLM should open next

### 已知缺口

- Conflicts, missing evidence, cancelled coverage

### 证据

- Source Citations beside factual explanations, using a local relative link such as
  `[Source: src/A.java L1-L2](../sources/app/src/A.java#L1-L2)`

Open with the product's value rather than its directory tree. Omit irrelevant prompts; merge small
topics into the narrative. Prose language follows `wikiLanguage`; paths stay untranslated.
