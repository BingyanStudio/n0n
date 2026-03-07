# TODO: Workspace 类封装重构

## 背景

PR #35 实现了 workspace 隔离，但采用**参数透传**方式将 `paths` 传递给所有消费模块，
导致 16 个文件的霰弹式修改（shotgun surgery）。每新增一个 workspace 感知的功能，
都需要在整条调用链上添加 `paths` 参数。

## 问题

当前架构：
```
app → discoverWorkflows(paths)
app → loadSchedules(paths)
app → agentLoop(history, { paths })
      → delegateTask(query, { paths })
        → discoverSkills(paths)
        → ragSearch(query, space, paths)
```

`paths` 作为 cross-cutting concern，在每个函数签名中重复出现。

## 建议方案：Workspace 类

将 workspace 相关的操作封装为 `Workspace` 类：

```ts
// packages/core/src/workspace.ts
export class Workspace {
  readonly paths: WorkspacePaths;

  constructor(workspaceDir: string) {
    this.paths = resolvePaths(workspaceDir);
  }

  discoverWorkflows(includeSkills?: boolean): Promise<WorkflowMeta[]> { ... }
  discoverSkills(): Promise<SkillMeta[]> { ... }
  loadSchedules(): Promise<ScheduleEntry[]> { ... }
  ragSearch(query: string, space?: SearchSpace): Promise<RagSearchResult> { ... }
  delegateTask<T>(query: string, opts?: DelegateOptions<T>): Promise<TaskResult<T>> { ... }
}
```

App 层使用：
```ts
// CLI
const workspace = new Workspace(".runtime/workflows");
const workflows = await workspace.discoverWorkflows();

// Feishu (per-user)
const workspace = new Workspace(`.runtime/feishu/${senderOpenId}`);
const result = await workspace.delegateTask(query);
```

## 收益

1. **新增功能零扩散** — 新方法只需加到 Workspace 类，调用方无需改签名
2. **语义更清晰** — `workspace.loadSchedules()` 比 `loadSchedules(paths)` 更直观
3. **便于测试** — 可以轻松创建临时 workspace 实例用于测试隔离
4. **AgentOptions 简化** — `agentLoop` 接受 `Workspace` 而非裸 `paths`

## 迁移策略

1. 创建 `Workspace` 类，内部委托给现有函数（现有函数保留 `paths` 参数作为底层 API）
2. App 层逐步迁移到 `Workspace` 实例
3. 稳定后移除独立函数的 `paths` 参数，改为 `Workspace` 方法专属

## 优先级

中等 — 当前方案功能正确，但每次新增 workspace 感知功能时技术债会累积。
