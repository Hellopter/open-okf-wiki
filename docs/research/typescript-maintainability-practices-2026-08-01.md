# TypeScript Monorepo 可维护性与防过度设计：官方实践研究

**研究日期：** 2026-08-01
**范围：** TypeScript、typescript-eslint、Node.js 与 Zod 的官方一手文档。本文不审查仓库实现；`strict`、`noUnused*`、Zod contract、宽 barrel、较多 `Record<string, unknown>`、port/adapter 是本次任务提供的项目特征，而非本研究新发现。

---

## 结论

代码量变大后，主要维护成本不是“类型少”，而是同一事实被 schema、类型、adapter、barrel 与泛型层重复描述。优先让每个边界只有一个可验证的契约、让每个 package 有小而明确的公共面；不要为了理论上的替换性或复用性预先增加 port、adapter、泛型或类型体操。

推荐的判断标准是：**新增抽象必须同时减少至少一个已存在的变化轴**（运行时输入来源、可替换实现、跨包公共 API、或重复的类型关系）。否则优先保留直接函数、局部类型和直接导入。

## 与当前特征对应的实践

### 1. 外部输入停在 `unknown`，在边界解析一次

对 HTTP、文件、环境变量、工具返回值、持久化 JSON 等不可信输入，入口接受 `unknown`，立即用该边界的 Zod schema 做 `parse` / `safeParse`，之后只传递 schema 推导出的领域类型。Zod 的 `.parse()` 会校验并返回强类型深拷贝，`.safeParse()` 返回可由 `success` 区分的结果；schema 也能推导静态类型。因此 schema 应是运行时契约的唯一事实源，避免再手写一份近似的 `interface`。

`Record<string, unknown>` 只适合键确实开放的 metadata、透传扩展字段或原始 JSON 暂存。TypeScript 将 string index signature 定义为“键名未知、值形状已知”的 dictionary；它会迫使所有显式属性兼容索引值类型。对已知业务字段，应使用具名对象、可辨识 union 或精确 schema，而不是把内部 contract 降级为开放字典。

来源：

- [Zod: Basic usage](https://zod.dev/basics)
- [TypeScript Handbook: Object Types - Index Signatures](https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures)
- [TypeScript Handbook: Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)

不要机械套用：同一进程内、已由可信函数产出的临时值不必再次 Zod parse；这会复制 schema、增加分配和错误分支。`unknown` 也不是最终领域模型，若一个值跨过边界后仍长期是 `Record<string, unknown>`，应优先补足该边界的实际契约。

### 2. 保留真正关联类型的泛型，删除只出现一次的泛型

泛型的价值是关联多个位置的类型，例如输入与输出必须保持相同，或 key 必须属于传入对象。仅出现一次的类型参数并没有建立关系，typescript-eslint 明确指出它通常可替换为 `unknown`，且会降低可读性、掩盖不安全断言。对配置表、handler registry 这类“需检查是否满足 shape，同时保留对象字面量最精确推断”的情况，优先 `satisfies`，不要为了检查 shape 而宽化整张表。

来源：

- [typescript-eslint: no-unnecessary-type-parameters](https://typescript-eslint.io/rules/no-unnecessary-type-parameters/)
- [TypeScript Handbook: Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)
- [TypeScript 4.9: `satisfies` operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)

不要机械套用：泛型恰好只在公开签名中出现一次、但由调用方指定返回策略时，仍可能是合理 API；必须按调用方是否需要这个自由度判断。`satisfies` 不会产生运行时校验，不能替代 Zod 对外部数据的验证。

### 3. Port/adapter 只围绕真实替换点和副作用边界

把存储、网络、进程、时钟、第三方 SDK 等副作用集中在 adapter 边界是合理的；端口应描述调用者真正需要的少量行为，而不是镜像底层 SDK 的完整接口。对于只有一个实现、没有替换计划、也未跨越副作用边界的纯业务协作，直接调用局部模块通常更易读、更容易改。

Node 的 `package.json#exports` 能明确一个 package 的可导入入口并阻止未列出的子路径，官方将其视为定义公共接口的封装机制。将跨 package 的 port/contract 放在拥有该 API 的 package 根入口；不要在共享 `common` 包预建“未来可能用到”的 ports。宽 barrel 应被当成公共 API 清单，而不是 `export *` 的文件系统镜像。

来源：

- [Node.js: Package entry points and `exports`](https://nodejs.org/api/packages.html#package-entry-points)
- [Node.js: Package self-reference](https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name)

不要机械套用：给既有 package 新增 restrictive `exports` 会阻断之前可用的深层导入，Node 官方将其标为潜在 breaking change。应先盘点已用入口、明确迁移期，再收窄公共面；不要用一次全仓替换冒险完成。

### 4. 区分 type-only 与运行时依赖，降低模块语义的隐性成本

对仅用于标注的跨包依赖使用 `import type` / `export type`。TypeScript 的 `verbatimModuleSyntax` 明确规定：带 `type` 的导入导出会在 JS 输出中移除，未带的保留；typescript-eslint 的 `consistent-type-imports` 可统一这一约定。这个约定能让 barrel 的运行时依赖更可见，避免类型依赖看起来像值依赖。

来源：

- [TypeScript: `verbatimModuleSyntax`](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html)
- [typescript-eslint: consistent-type-imports](https://typescript-eslint.io/rules/consistent-type-imports/)

不要机械套用：不要只为启用该规则而改变 package 的 ESM/CJS 方案。`verbatimModuleSyntax` 会使模块格式不一致直接报错，须先确认 Node 版本、`package.json#type`、打包器和测试执行器的模块策略一致。

### 5. `strict` 与未使用检查保留为护栏，不要用它们催生样板代码

`strict` 打开一组更强的正确性检查，但官方说明未来 TypeScript 版本可在该组中加入新检查，因此升级会出现新增诊断。将 compiler 版本与关键严格选项作为显式工程约束，在升级 PR 中处理新增错误；不要关闭整个 `strict` 来绕过局部问题。

`noUnusedLocals` 只报告未读取的局部变量。面对这类错误应删除死代码、缩小 API 或改正实现，不应加空 adapter、无意义的 `void value`、或为了“用到它”而把值层层传递。

对开放索引访问，`noUncheckedIndexedAccess` 会把未声明字段变为 `T | undefined`；这对真正的字典与外部 metadata 有价值。可选字段语义中“字段不存在”与“字段值为 `undefined`”不同，才考虑 `exactOptionalPropertyTypes`。

来源：

- [TypeScript: `strict`](https://www.typescriptlang.org/tsconfig/strict.html)
- [TypeScript: `noUnusedLocals`](https://www.typescriptlang.org/tsconfig/noUnusedLocals.html)
- [TypeScript: `noUncheckedIndexedAccess`](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)
- [TypeScript: `exactOptionalPropertyTypes`](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html)

不要机械套用：后两项会扩大既有错误面，若大量 legacy JSON / option bag 仍未建模，先在新增 contract 或特定 package 试点，修复真实的缺失处理，再评估全局启用。它们不是“类型更严格就必然更可维护”的开关。

### 6. Lint 规则按信号与成本分层启用

`no-explicit-any` 可阻止显式 `any`，官方建议未知类型用更安全的 `unknown`。`no-unsafe-assignment` 能防止外部或第三方类型中的 `any` 渗入，但需要类型信息并有性能代价。`no-unnecessary-type-parameters` 同样需要类型信息，且官方提示该规则有复杂的限制条件。

建议把 `no-explicit-any` 作为基础护栏；对边界 package 或高风险层试点 type-aware 规则，记录 lint 时长、误报类别与修复收益后再扩展。规则是发现设计信号的工具，不是自动重构命令。

来源：

- [typescript-eslint: no-explicit-any](https://typescript-eslint.io/rules/no-explicit-any/)
- [typescript-eslint: no-unsafe-assignment](https://typescript-eslint.io/rules/no-unsafe-assignment/)
- [typescript-eslint: no-unnecessary-type-parameters](https://typescript-eslint.io/rules/no-unnecessary-type-parameters/)

不要机械套用：不要在一个变更中启用全仓 type-aware recommended/strict 配置并顺手改数百处。那会把规则迁移噪声与架构修改混在一起，难以审查，也不能证明每处抽象都值得保留。

### 7. 编译性能问题先度量，再拆 project 或改高级类型

TypeScript 官方性能指南建议：当 editor 已因规模难以处理、并且 trace 排除了具体热点时，再使用 project references；monorepo 可让每个 package 对应一个引用项目，但应避免一个巨大项目和很多微小卫星项目。指南也提供 `--generateTrace` 以确认编译器把时间花在哪里。

这意味着不要把 project references 当成“代码多”的默认解，也不要仅为让类型看起来通用而堆叠深层 conditional/mapped/intersection types。先以 trace、类型检查时间和编辑器响应作为证据；再将性能热点附近的类型命名、拆分或简化。

来源：

- [TypeScript Wiki: Performance](https://github.com/microsoft/TypeScript/wiki/Performance)
- [TypeScript Handbook: Conditional Types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)

不要机械套用：项目引用增加 tsconfig、构建顺序和声明产物维护成本；只有性能数据或 package 边界已经稳定时才值得引入。复杂类型并非天然错误，若它准确表达了对外 contract 且测试、编译性能均可接受，应保留并给它命名。

## 建议的收敛顺序

1. 先按“外部输入 -> Zod parse -> 领域类型”画出边界，不对内部可信值重复验证。
2. 为每个 package 列出公开入口，区分 public / internal；把宽 barrel 收敛为有意维护的 API 清单，再考虑 Node `exports`。
3. 逐个审视 port、adapter、泛型与 `Record<string, unknown>`：写下它当前减少的变化轴；写不出来的先内联或降为局部实现。
4. 小范围试点 type-aware lint 与更严格索引检查，按 lint/tsc 耗时和真实缺陷数决定是否扩大。
5. 只有确认编辑器或 typecheck 性能问题时，生成 trace 后再设计 project references 或类型简化。

该顺序的目的不是减少类型安全，而是让运行时契约、编译期关系、package 公共面各自只承担一种职责，从而减少后续修改时需要同步维护的文件与概念数。
