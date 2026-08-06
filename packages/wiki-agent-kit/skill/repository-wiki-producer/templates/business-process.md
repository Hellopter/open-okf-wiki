# Business Process template

**Use when:** readers need an end-to-end journey with rules, branches, and side effects.
**Do not use when:** the path is a single pure function with no business decision; use Module/Concept.

## Frontmatter contract

```yaml
---
type: Business Process
title: 订单提交流程
description: 草稿订单如何校验、持久化、失败回滚并通知下游。
---
```

## Required sections

Every heading below is mandatory. Do not silently omit one. If evidence is missing, write
`当前证据未发现` under that heading and add a gap.

### 业务目标

- Reader question this process answers
- Success meaning in business terms

### 参与角色与边界

- Human/system actors
- Domain and module participants

### 前置条件

- Required states, permissions, inputs, and external readiness

### 触发条件

- Concrete trigger (API, message, job, UI action)

### 主流程

Ordered steps. Prefer a numbered list:

1. Step summary — owning module/service — evidence link
2. …

Optional Mermaid sequence/flow diagram only when it clarifies the same evidence.

### 分支与失败路径

- Business branches and technical failures
- Retry/compensation/idempotency when present
- What the caller observes on failure

### 状态变化

- Entity/status transitions on success and failure

### 副作用

- DB writes, events, emails, external calls, cache updates

### 代码与数据映射

- Entry signature → application/domain methods → tables/topics
- Links to Data Model / Module pages

### 已知缺口

- Untraced hops, conflicting docs, unproven claims

### 证据

- Local relative Source Citations with real line ranges for each material stage

## Minimum evidence

- Trigger and at least one implementation hop with line evidence
- Persistence or side-effect claims need write-path evidence
- Inferred hops must be labeled as inferred and preferably recorded as gaps

## Anti-examples

- Title-only page with a generic “处理请求” paragraph
- Class list without trigger/outcome/failure
- Happy path only when source clearly branches on validation errors

## Quality self-check

- Can a reader restate trigger, outcome, ordered steps, failure exits, state changes, and side effects?
- Does every critical step cite frozen sources?
- Are identifiers untranslated inside Chinese prose?
