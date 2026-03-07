# Workspace 隔离设计

## 动机

当前所有路径（tasks/skills/schedules/memory 等）硬编码为 `workflows/` 子目录，存在三个问题：

1. **code app 无法操作其他项目** — 工具的 cwd 和 workspace 路径耦合在一起
2. **飞书多用户共享同一 workspace** — 不同用户的 workflow/memory 互相可见
3. **workflows/ 目录提交到 git** — 运行时产物不应进入版本控制

## 核心变更：`paths` 从单例常量改为函数

### 现状

```ts
// packages/core/src/config.ts
export const paths = {
  workflows: "workflows",
  tasks: "workflows/tasks",
  skills: "workflows/skills",
  // ...
} as const;
```

模块级常量，所有调用方共享同一份路径。

### 目标

```ts
export interface WorkspacePaths {
  root: string;       // workspace 根目录
  tasks: string;
  skills: string;
  schedules: string;
  memory: string;
  consultResult: string;
  history: string;
  temp: string;
}

export function resolvePaths(workspace: string): WorkspacePaths {
  return {
    root: workspace,
    tasks: `${workspace}/tasks`,
    skills: `${workspace}/skills`,
    schedules: `${workspace}/schedules`,
    memory: `${workspace}/memory`,
    consultResult: `${workspace}/consult-result`,
    history: `${workspace}/history`,
    temp: `${workspace}/.temp`,
  };
}
```

调用方传入 workspace 路径，获得完整的路径集合。

## 各 App 的 workspace 策略

| App | 默认 workspace | 说明 |
|-----|---------------|------|
| `apps/cli` | `.runtime/workflows` | 单用户，启动时确定 |
| `apps/code` | `.runtime/code` | 单用户，支持 `--workspace` 覆盖 |
| `apps/feishu` | `.runtime/feishu/<senderOpenId>` | 多用户，每次请求动态计算 |

## 影响范围

### 需要改的文件

| 文件 | 变更 |
|------|------|
| `packages/core/src/config.ts` | `paths` 常量 → `resolvePaths(workspace)` 函数 |
| `packages/core/src/workflow/runtime.ts` | `paths.tasks` → 接受 paths 参数 |
| `packages/core/src/skills/discovery.ts` | `paths.skills` → 接受 paths 参数 |
| `packages/core/src/scheduler/scheduler.ts` | `paths.schedules` → 接受 paths 参数 |
| `packages/core/src/task/delegate.ts` | `paths.*` → 接受 paths 参数 |
| `packages/core/src/task/rag.ts` | `paths.*` → 接受 paths 参数 |
| `apps/cli/src/index.ts` | 启动时设置 workspace = `.runtime/workflows` |
| `apps/cli/src/repl.ts` | 传递 paths 给 core API |
| `apps/code/src/index.ts` | `--cwd` → `--workspace`，默认 `.runtime/code` |
| `apps/feishu/src/session.ts` | 每个 session 关联独立的 paths |
| `apps/feishu/src/conversation.ts` | 传递 per-user paths 给 agentLoop |

### 传递方式

paths 通过 `AgentOptions` 传入 `agentLoop()`，再透传给工具和内部模块：

```ts
// AgentOptions 新增
interface AgentOptions<T> {
  // ...existing
  paths?: WorkspacePaths;  // 不传则使用默认
}
```

`discoverWorkflows()`、`loadSchedules()` 等独立函数也需要接受 paths 参数：

```ts
discoverWorkflows(paths)
loadSchedules(paths)
```

## 清理

1. `.runtime/` 加入 `.gitignore`
2. 删除 `workflows/` 目录（含 git 历史）：`git filter-repo --path workflows/ --invert-paths`
3. 删除 `.temp/` 加入 `.gitignore`（已有则确认）

## 实施顺序

1. `resolvePaths()` 函数 + `WorkspacePaths` 类型
2. `AgentOptions` 新增 `paths` 字段
3. 逐个改造 core 内部模块（runtime/discovery/scheduler/delegate/rag）
4. 改造 apps/cli（默认 `.runtime/workflows`）
5. 改造 apps/code（`--workspace`，默认 `.runtime/code`）
6. 改造 apps/feishu（per-user workspace）
7. `.gitignore` + 清理 `workflows/` 历史
