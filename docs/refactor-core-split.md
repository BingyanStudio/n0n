# Core 模块拆分计划

## 目标

将 `@n0n/core`（17 个文件）拆分为 4 个职责单一的包，使 `core` 只保留 agentLoop 核心。

## 现状

```
packages/core/src/          # 17 files, 混合了核心循环 + 工具函数 + 业务流水线 + 调度
├── agent/loop.ts           # agentLoop 核心循环
├── agent/tool.ts           # 工具调用解析
├── runtime.ts              # RuntimeContext 单例
├── ui/renderer.ts          # PlainRenderer
├── workspace.ts            # 路径解析 (Base + Workflow)
├── prompts/agents-md.ts    # AGENTS.md 加载
├── utils/frontmatter.ts    # YAML frontmatter 解析
├── skills/discovery.ts     # Skill 扫描
├── discovery.ts            # 统一发现入口 (re-export)
├── schema.ts               # InteractiveResultSchema
├── task/delegate.ts        # delegateTask 流水线
├── task/generate.ts        # generate 轻量 API
├── task/rag.ts             # RAG 检索
├── workflow/runtime.ts     # Workflow 发现 + 执行
├── prompts/delegate.md     # delegate system prompt
├── scheduler/scheduler.ts  # 定时调度
├── scheduler/cron.ts       # cron 解析
└── index.ts
```

## 目标结构

### `@n0n/shared` — 通用工具池（扩充）

```
packages/shared/src/
├── tags.ts                 # (已有) XML tag 工具
├── agents-md.ts            # ← core: AGENTS.md 加载/格式化
├── frontmatter.ts          # ← core: YAML frontmatter 解析
├── workspace.ts            # ← core: BaseWorkspacePaths + resolveBasePaths + ensureDirs + parseWorkspaceArg
├── skills/discovery.ts     # ← core: Skill 扫描 + 解析
├── skills/types.ts         # ← core: SkillMeta, SkillContent 类型
└── index.ts
依赖: @n0n/types, zod
```

### `@n0n/core` — agentLoop 核心（瘦身）

```
packages/core/src/
├── agent/loop.ts           # agentLoop
├── agent/tool.ts           # 工具调用解析
├── runtime.ts              # RuntimeContext 单例
├── ui/renderer.ts          # PlainRenderer
└── index.ts
依赖: @n0n/types, @n0n/llm, @n0n/tools, @n0n/shared
```

### `@n0n/workflow` — 新包：task pipeline + 资源发现

```
packages/workflow/src/
├── types.ts                # WorkflowMeta, RagHit
├── workspace.ts            # WorkflowPaths + resolveWorkflowPaths
├── builders.ts             # buildSkillContext, buildRagContext 等 prompt builders
├── workflow/runtime.ts     # Workflow 发现 + 执行
├── task/delegate.ts        # delegateTask 流水线
├── task/generate.ts        # generate 轻量 API
├── task/rag.ts             # RAG 检索
├── prompts/delegate.md     # delegate system prompt
├── discovery.ts            # 统一发现入口
├── schema.ts               # InteractiveResultSchema
└── index.ts
依赖: @n0n/core, @n0n/types, @n0n/llm, @n0n/shared
```

### `@n0n/scheduler` — 新包：格式标准 + 解析 + 调度

```
packages/scheduler/src/
├── types.ts                # ScheduleEntry, CronFields
├── scheduler.ts            # 调度循环 + MDC 解析
├── cron.ts                 # cron 表达式解析
└── index.ts
依赖: @n0n/workflow, @n0n/shared, @n0n/core
```

## 依赖图

```
types (0 deps)
  ↑
shared (→ types)
  ↑
llm (→ types, shared)     tools (→ types)
  ↑                          ↑
  └──────── core ────────────┘  (→ types, llm, tools, shared)
              ↑
           workflow (→ core, types, llm, shared)
              ↑
           scheduler (→ workflow, shared, core)
```

## Apps 依赖

| App | 依赖 |
|-----|------|
| apps/code | core, shared |
| apps/cli | core, shared, workflow, scheduler |
| apps/feishu | core, shared, workflow, scheduler |
| apps/scheduler | core, shared, scheduler |

## 实施步骤

### Step 1: 创建分支

```
git checkout -b refactor/split-core
```

### Step 2: 扩充 shared

1. 迁入 `agents-md.ts` → `shared/src/agents-md.ts`
2. 迁入 `frontmatter.ts` → `shared/src/frontmatter.ts`
3. 拆分 `workspace.ts`:
   - `BaseWorkspacePaths` + `resolveBasePaths` + `ensureDirs` + `parseWorkspaceArg` → `shared/src/workspace.ts`
4. 迁入 `skills/discovery.ts` → `shared/src/skills/discovery.ts`
   - 提取 `SkillMeta`/`SkillContent` 类型到 `shared/src/skills/types.ts`
5. 更新 `shared/src/index.ts` 导出
6. 更新 `shared/package.json` 添加 zod 依赖
7. 验证: `tsc --noEmit && biome check`
8. 提交

### Step 3: 创建 @n0n/workflow

1. 创建 `packages/workflow/` 目录结构 + `package.json` + `tsconfig.json`
2. 迁入文件:
   - `workspace.ts` 中的 `WorkflowPaths` + `resolveWorkflowPaths` → `workflow/src/workspace.ts`
   - `task/delegate.ts` → `workflow/src/task/delegate.ts`
   - `task/generate.ts` → `workflow/src/task/generate.ts`
   - `task/rag.ts` → `workflow/src/task/rag.ts`
   - `workflow/runtime.ts` → `workflow/src/workflow/runtime.ts`
   - `discovery.ts` → `workflow/src/discovery.ts`
   - `schema.ts` → `workflow/src/schema.ts`
   - `prompts/delegate.md` → `workflow/src/prompts/delegate.md`
3. 创建 `workflow/src/types.ts` (WorkflowMeta, RagHit)
4. 创建 `workflow/src/builders.ts` (prompt builder 函数)
5. 更新所有内部 import 路径
6. 更新 `workflow/src/index.ts` 导出
7. 验证: `tsc --noEmit && biome check`
8. 提交

### Step 4: 创建 @n0n/scheduler

1. 创建 `packages/scheduler/` 目录结构 + `package.json` + `tsconfig.json`
2. 迁入文件:
   - `scheduler/scheduler.ts` → `scheduler/src/scheduler.ts`
   - `scheduler/cron.ts` → `scheduler/src/cron.ts`
3. 提取类型到 `scheduler/src/types.ts`
4. 更新 import 路径
5. 验证: `tsc --noEmit && biome check`
6. 提交

### Step 5: 瘦身 core

1. 从 core 删除已迁出的文件
2. 更新 `core/src/index.ts` — 只导出 agentLoop + runtime + PlainRenderer
3. 更新 `core/package.json` 依赖
4. 验证: `tsc --noEmit && biome check`
5. 提交

### Step 6: 更新 Apps

1. `apps/code` — import 从 `@n0n/core` 改为 `@n0n/core` + `@n0n/shared`
2. `apps/cli` — import 拆分到 `@n0n/core` + `@n0n/shared` + `@n0n/workflow` + `@n0n/scheduler`
3. `apps/feishu` — 同上
4. `apps/scheduler` — import 拆分到 `@n0n/core` + `@n0n/shared` + `@n0n/scheduler`
5. 更新各 app 的 `package.json` 依赖
6. 验证: `tsc --noEmit && biome check && bun test`
7. 提交

### Step 7: 清理

1. 删除 core 中残留的空目录
2. 全量验证: `turbo typecheck && turbo check && bun test`
3. 最终提交

## 风险

- **循环依赖**: scheduler → workflow → core 是单向的，无风险
- **import 路径遗漏**: 通过 tsc 全量检查捕获
- **运行时行为**: 纯重构，不改逻辑，通过现有测试验证
