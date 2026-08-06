# Known Gap template

**Use when:** evidence is missing, conflicting, or intentionally out of scope and readers must not
treat silence as completeness.
**Do not use when:** the fact is proven; put it on the owning domain/process/module page instead.

## Frontmatter contract

```yaml
---
type: Known Gap
title: 订单补偿路径证据不足
description: 提交失败后的补偿调用在当前快照中缺少可验证实现。
---
```

## Required sections

### 缺口陈述

- What is unknown, conflicting, or cancelled
- Why a reader/LLM should care

### 影响范围

- Pages, flows, modules, or coverage units affected

### 已有证据

- What was inspected, with Source Citations
- Competing claims quoted briefly when conflict exists

### 当前处理

- Structured cancellation, non-critical page, or open question id
- What must not be invented downstream

### 建议后续调查

- Concrete files/entry points to inspect next
- No fake “already verified” claims

### 证据

- Citations for the inspected paths even when they are negative evidence

## Minimum evidence

- At least one inspected path showing absence, conflict, or partial implementation

## Quality self-check

- Does the page prevent hallucinated completion of the missing path?
- Is the gap linked from the process/domain that needs it?
