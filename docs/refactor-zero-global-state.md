# Refactor: Zero Global State

> 消除所有全局可变单例，配置从 app 入口显式传递。

## 现状问题

当前架构有 3 层全局可变单例，通过 `init/get` 模式传递：

```
App 入口 → initConfig()
  ├── _currentPaths        → getCurrentPaths()   → 6 个 core 函数默认值
  ├── initLLMConfig()      → getLLMConfig()       → chatCompletion/stream/tags
  └── initToolsConfig()    → getToolsConfig()     → exec (blocked/workspace/temp)
```

| 问题 | 影响 |
|---|---|
| 模块加载自动 `initConfig()` | `import` core 就在 cwd 创建全套目录 |
| `resolvePaths()` 总生成全部 9 个路径 | code 模式创建了 7 个不需要的目录 |
| `_currentPaths` 全局单例 | feishu 多用户场景下无意义，已被绕开 |
| `delegateTask` 内部临时 `initToolsConfig()` | 并发场景下 race condition |
| 3 个 app 各自重复 `--workspace` 解析 | 逻辑冗余 |

## 目标架构

**零全局可变状态。** 所有配置从 app 入口构造，通过参数显式传递到每一层。

### 类型体系：Base + Extend

```ts
// packages/core/src/workspace.ts

/** 所有模式共享的最小路径集 */
interface BaseWorkspacePaths {
  workspace: string;
  temp: string;
}

/** CLI/Feishu 模式 — workflow builder 场景 */
interface WorkflowPaths extends BaseWorkspacePaths {
  workflows: string;
  tasks: string;
  skills: string;
  schedules: string;
  memory: string;
  consultResult: string;
  history: string;
}

// Code 模式直接使用 BaseWorkspacePaths，不需要 workflow 相关路径
```

### 运行时上下文：替代全局单例

```ts
// packages/core/src/runtime.ts

/** LLM 连接配置 — 从 env vars 构造，不可变 */
interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  enableThinking: boolean;
}

/** Agent 行为配置 */
interface AgentConfig {
  maxIterations: number;
  maxIdleRounds: number;
  defaultExecTimeout: number;
}

/** 安全策略 */
interface SecurityConfig {
  blockedCommands: string[];
}

/** 运行时上下文 — 替代所有全局单例 */
interface RuntimeContext {
  llm: LLMConfig;
  agent: AgentConfig;
  security: SecurityConfig;
}
```

### 函数签名变化

```ts
// Before (隐式全局依赖)
agentLoop(history, { maxIterations, renderer, schema })
chatCompletionStream({ messages, tools })        // 内部 getLLMConfig()
exec(script)                                      // 内部 getToolsConfig()

// After (显式传递)
agentLoop(history, { runtime, paths, renderer, schema })
chatCompletionStream({ messages, tools }, { llm })
exec(script, { security, workspace, tempDir })
```

## 迁移步骤

分 4 个 PR，每个独立可验证：

### PR 1: 路径类型重构 + 目录创建修复

**改动范围：** `packages/core`, `apps/*`

1. 新建 `packages/core/src/workspace.ts`
   - 定义 `BaseWorkspacePaths` + `WorkflowPaths`
   - `resolveWorkflowPaths(workspace)` — 生成 workflow 场景全部路径
   - `resolveBasePaths(workspace)` — 仅生成 base 路径
   - `ensureDirs(paths)` — 通用，遍历传入对象的所有值创建目录
   - `parseWorkspaceArg(args, envKey, defaultPath)` — 通用 CLI 参数解析

2. 各 app 入口使用新的路径函数
   - `apps/code` → `resolveBasePaths()`
   - `apps/cli` → `resolveWorkflowPaths()`
   - `apps/feishu` → `resolveWorkflowPaths()`（保留 per-user 逻辑）

3. 移除 `config.ts` 中的路径相关代码
   - 删除 `_currentPaths`, `getCurrentPaths()`, `ensureWorkspaceDirs()`
   - `resolvePaths()` → 重定向到 workspace.ts

4. core 内部函数 paths 参数改为必传
   - `delegateTask`, `generate`, `discoverWorkflows`, `ragSearch`, `loadSchedules`, `startScheduler`

5. 移除模块加载自动 `initConfig()` 调用

### PR 2: LLM 配置去全局化

**改动范围：** `packages/llm`, `packages/core`

1. `chatCompletion` / `chatCompletionStream` 接受 `llm: LLMConfig` 参数
2. `adaptTags` / `wrapTag` 接受 `model: string` 参数（已部分支持）
3. `agentLoop` 接受 `llm: LLMConfig` 并传递给 stream 调用
4. 删除 `initLLMConfig()` / `getLLMConfig()` 全局单例
5. App 入口从 env vars 构造 `LLMConfig` 并传入

### PR 3: Tools 配置去全局化

**改动范围：** `packages/tools`, `packages/core`

1. `makeToolkit()` 接受 `{ security, agent, workspace, tempDir }` 参数
2. `exec` 的 `workspace` / `tempDir` / `blockedCommands` 从参数获取
3. `agentLoop` 将配置传递给 `makeToolkit()`
4. 删除 `initToolsConfig()` / `getToolsConfig()` 全局单例
5. 删除 `delegateTask` / `generate` 中临时调用 `initToolsConfig()` 的 hack

### PR 4: 清理 + config.ts 最终形态

1. `config.ts` 仅保留 env vars 读取的纯函数（无全局状态）
2. 删除 `initConfig()` — 各 app 自行组装
3. 导出整理，确保 `@n0n/core` 的公共 API 干净

## 验收标准

- [ ] `bunx tsc --noEmit` 零错误
- [ ] `grep -r 'initConfig\|getCurrentPaths\|getLLMConfig\|getToolsConfig\|initLLMConfig\|initToolsConfig' packages/ apps/` 返回空
- [ ] Code 模式启动后，workspace 下只有 `.temp/` 目录
- [ ] CLI 模式启动后，workspace 下有完整的 `workflows/` 目录结构
- [ ] Feishu 模式下多用户路径隔离正常
- [ ] 无任何模块加载副作用（`import` 不触发文件系统操作）
