# Data Model template

**Use when:** entities, tables, events, or documents have ownership and consistency rules readers need.
**Do not use when:** a single DTO is only an API detail; keep it on the API/Module page.

## Frontmatter contract

```yaml
---
type: Data Model
title: 订单数据模型
description: 订单主表、明细与状态字段的所有权及一致性约束。
---
```

## Required sections

### 模型范围

- Which business entities/records are in scope
- Explicit exclusions

### 核心实体与关系

- Entities and relationships
- Optional Mermaid ER diagram when it reduces ambiguity

### 字段与约束

- Identity keys, required fields, uniqueness, enums/status
- Keep column/field identifiers untranslated

### 所有权与一致性

- Owning domain/module
- Transaction/consistency expectations visible in source

### 读写路径

- Who writes/reads this model and through which APIs/jobs

### 代码与存储映射

- Classes/schemas/migrations/tables/collections

### 已知缺口

- Missing migrations, undocumented fields, doc/code mismatch

### 证据

- Source Citations for schema and write paths

## Minimum evidence

- At least one schema/type/table definition span
- Ownership claims need module or repository evidence

## Quality self-check

- Can a reader find the authoritative store and the writer path?
- Are constraints sourced rather than assumed?
