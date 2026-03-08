# Workspace Isolation 缺漏清单

基于 `refactor/workspace-isolation-v2` 分支（PR #37）的两轮审查汇总。
本文档仅记录问题，不包含实现。

---

## 🔴 高优先级

### GAP-1: `lagacy_paths` 仍作为 6 处函数默认值

文档要求"不依赖全局隐式状态"，但以下函数仍默认 `lagacy_paths`（模块加载时快照，基于 `process.cwd()`，不反映 `initConfig` 后的实际路径）：

| 文件 | 函数 | 行 |
|---|---|---|
| `packages/core/src/workflow/runtime.ts` | `discoverWorkflows()` | 36 |
| `packages/core/src/task/rag.ts` | `ragSearch()` | 108 |
| `packages/core/src/skills/discovery.ts` | `discoverSkills()` | 57 |
| `packages/core/src/scheduler/scheduler.ts` | `loadSchedules()` | 36 |
| `packages/core/src/scheduler/scheduler.ts` | `setScheduleEnabled()` | 71 |
| `packages/core/src/scheduler/scheduler.ts` | `startScheduler()` | 108 |

**修复方向**：将默认值全部改为 `getCurrentPaths()`，与 `delegateTask`/`generate` 保持一致。`lagacy_paths` 仅保留为导出的兼容别名。

### GAP-2: Feishu per-user 工具隔离失效

Feishu 启动时用 `initConfig()` 初始化全局 tools config 为 scheduler workspace（`.runtime/feishu/scheduler`）。之后 per-user session 通过 `resolveFeishuPaths()` 计算出用户专属路径，但 `agentLoop` 内部的工具执行（`exec` 的 cwd、temp）仍读取全局 `getToolsConfig()`，指向 scheduler workspace 而非 `session.paths.workspace`。

**影响**：所有飞书用户的 `exec` 工具实际在 scheduler 目录下执行，per-user workspace 隔离形同虚设。

**修复方向**：需要 per-session 的 tools config 机制。可选方案：
1. 在 `agentLoop` / tool execution 层支持传入 workspace override
2. 在每个 round 执行前 set、执行后 restore tools config（需并发保护）
3. 将 tools config 从全局单例改为上下文传递

来源：`apps/feishu/src/index.ts:48-60`（Copilot review）

### GAP-3: Scheduler 不传播 workspace 给 runWorkflow / delegateTask

`startScheduler()` 接收 `SchedulerPaths`（仅含 `schedules`），触发时调用 `runWorkflow(entry.workflow)` 和 `delegateTask(entry.prompt)` 但不传播 workspace 配置。

**影响**：当 `process.cwd() != workspace root` 时（如 Feishu scheduler），frontmatter 中的 `workflow: workflows/tasks/xxx.ts` 会基于错误的 base 解析，导致找不到文件。`delegateTask` 也会使用错误的路径配置。

**修复方向**：扩展 `SchedulerPaths` 包含 `workspace`（及可选的 `tasks`/`temp`），`runWorkflow` 的路径基于 workspace 解析，`delegateTask` 传入对应的 `pathConfig`。

来源：`packages/core/src/scheduler/scheduler.ts:107-115`（Copilot review）

### GAP-4: `exec` 相对路径 cwd 解析基于 process.cwd() 而非 workspace

`execToolStream` 中 `cwd = resolve(args.cwd ?? getToolsConfig().workspace)`。当模型传入相对路径（如 `src`）时，`path.resolve()` 会基于 `process.cwd()` 而非注入的 workspace 解析，破坏 workspace 驱动语义。

**修复方向**：相对路径应基于 `getToolsConfig().workspace` 解析，绝对路径保持不变：
```ts
const base = getToolsConfig().workspace;
const cwd = args.cwd
  ? (isAbsolute(args.cwd) ? args.cwd : resolve(base, args.cwd))
  : base;
```

来源：`packages/tools/src/exec.ts:211-213`（Copilot review）

### GAP-5: `workflows/` 仍被 git 跟踪

`.gitignore` 已加入 `workflows/`，但 `git ls-files workflows/` 仍返回 28 个文件（skills、tasks、schedules、memory 等）。新提交不会新增文件，但已跟踪的文件不会自动移除。

**修复**：`git rm -r --cached workflows/ && git commit`。`git filter-repo` 清理历史是可选的破坏性操作，不在本轮范围。

---

## 🟡 中优先级

### GAP-6: Code app repl.ts 重复调用 initConfig

`apps/code/src/repl.ts:54` 的 `startCodeRepl()` 内部再次调用 `initConfig()`，而 `apps/code/src/index.ts:22` 已经调用过一次。与 CLI issue 4（已修复）是同一模式。

更严重的是，repl.ts 只传入 `{ workspace, temp }`，导致 `workflows`/`tasks`/`skills` 等字段回退到 `resolvePaths()` 的 `process.cwd()` 默认值，覆盖了 index.ts 中的完整初始化。

**修复方向**：删除 repl.ts 中的 `initConfig` 调用，路径已由 index.ts 初始化完成。

### GAP-7: submit 工具 discriminated union required 字段丢失

`makeSubmitToolDefinition()` 中 `schemaRequired` 仅从 `jsonSchema.required` 读取。对于 `z.discriminatedUnion`（生成 `oneOf`/`anyOf`），Zod 将 `required` 放在每个 variant 内部而非顶层，导致顶层 `required` 为空数组。

**影响**：模型更容易省略必填字段（如 discriminator `type`），依赖 retry-on-validation-failure 才能纠正。

**修复方向**：当顶层 `required` 缺失且存在 `oneOf`/`anyOf` 时，从各 variant 的 `required` 数组求交集，至少保证 discriminator 字段被标记为 required。

来源：`packages/tools/src/submit.ts:116`（Copilot review）

### GAP-8: `lagacy_paths` 拼写错误

`lagacy_paths` 是 "legacy" 的拼写错误。该常量被 6 个文件作为默认参数引用，并通过 `packages/core/src/index.ts` 以 `paths` 别名公开导出。

**修复方向**：重命名为 `legacy_paths`，保留 `lagacy_paths` 作为 deprecated 别名（一个过渡版本后移除）。公开导出的 `paths` 别名不受影响。

来源：`packages/core/src/config.ts:100`（Copilot review）

---

## 🟢 低优先级

### GAP-9: AGENTS.md 读取未实现

`workspace-isolation-retry.md` 明确要求 "AGENTS.md 应从 workspace 读取，不是 `process.cwd()`"，用户原话也包含此要求。但代码中没有任何文件引用 AGENTS.md——该功能完全未实现。

**说明**：如果 AGENTS.md 功能本身还未开发（不属于本轮 scope），这不算回归。但文档将其列为重做项，需确认是否纳入后续迭代。

**预期行为**：agent 启动时从 `workspacePaths.workspace` 目录读取 `AGENTS.md`（如存在），将其内容注入 system prompt，为 agent 提供项目级指令。

### GAP-10: `process.cwd()` 残留

文档原则 3 明确 "不要依赖 `process.cwd()`"，仍有两处残留：

1. **`resolvePaths()`**（`packages/core/src/config.ts:56`）— `workspace` 默认值为 `process.cwd()`。作为兼容性后备可接受，但应在注释中标记为 deprecated fallback。
2. **`resolveFeishuPaths()`**（`apps/feishu/src/paths.ts:16`）— `FEISHU_BASE` 使用 `resolve(process.cwd(), ".runtime", "feishu")`。Feishu 是长驻进程，`process.cwd()` 启动后不变，风险较低，但不符合"配置驱动"原则。

**修复方向**：`resolvePaths` 的 `process.cwd()` fallback 保留但加注释；Feishu base dir 改为从环境变量（如 `N0N_RUNTIME_DIR`）或启动参数获取，`process.cwd()` 仅作最终 fallback。
