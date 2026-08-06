# Business Domain template

**Use when:** a stable business boundary owns language, rules, and capabilities readers must grasp.
**Do not use when:** the material is only a thin package wrapper; fold into Overview or Module.

## Frontmatter contract

```yaml
---
type: Business Domain
title: 订单域
description: 订单从创建到履约的业务边界、对象与规则归属。
---
```

## Required sections

Copy these headings into the page. Replace bullets with evidence-backed content. If a section has
no evidence, keep the heading and state that explicitly.

### 业务目标

- What business outcome this domain owns
- Who cares about that outcome

### 参与角色与边界

- Actors inside/outside the domain
- Explicit non-goals and handoff points

### 核心对象与术语

- Entities/value objects and stable terms
- Code identifiers kept untranslated

### 业务能力

- Capabilities this domain offers
- Entry points that expose them

### 关键规则与状态

- Invariants, validation, lifecycle/status

### 上下游依赖

- Upstream triggers and downstream consumers

### 代码与模块映射

- Modules/packages/APIs that implement the domain

### 已知缺口

- Missing evidence, doc/code conflicts, open questions

### 证据

- Local Source Citations for each material claim

## Minimum evidence

- At least one ownership clue (module/API/package) and one business-facing entry or doc claim
- Rules/states require code or schema spans; otherwise mark as gap

## Quality self-check

- Can a new engineer explain the boundary without reading the whole repo?
- Are code names preserved beside Chinese terms?
- Is every direct claim cited?
