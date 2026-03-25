# Scheduler 触发的 Workflow 无 CWD 隔离

## 问题描述

Scheduler 通过 `runWorkflow(workflowPath)` 执行用户的 workflow 脚本时，使用 `import()` 动态加载并执行。但 `runWorkflow` **不设置工作目录（cwd）**，workflow 执行时的 cwd 仍然是飞书服务的启动目录（项目根目录），而不是用户的 workspace。

## 实际行为

### `runWorkflow`（`packages/workflow/src/workflow/runtime.ts`）

```typescript
export async function runWorkflow(workflowPath: string, args?: unknown): Promise<unknown> {
    const absPath = resolve(workflowPath);
    const mod = (await import(absPath)) as WorkflowModule;
    const entryFn = mod.default ?? mod.run;
    return entryFn(args);  // ← cwd 没有改变
}
```

### Scheduler 调用（`packages/scheduler/src/scheduler.ts`）

```typescript
const workflowPath = resolve(paths.workspace, entry.workflow);
runWorkflow(workflowPath)  // ← 路径是绝对路径，但 cwd 没设
```

### Workflow 脚本中的影响

Agent 编写的 workflow 脚本可能使用相对路径：

```typescript
// workflows/tasks/greet.ts
const userInfo = JSON.parse(await Bun.file("workflows/memory/user-info.json").text());
```

在 Agent 执行时（通过 exec 工具），cwd 是用户 workspace，相对路径正确。
但 Scheduler 触发时，cwd 是项目根目录，相对路径指向错误位置。

## 为什么这是问题

1. **Agent 编写的 workflow 和 Scheduler 执行的行为不一致**：Agent 测试通过的脚本在定时触发时可能失败
2. **文件操作指向错误位置**：相对路径读写会在项目根目录下操作，而不是用户 workspace
3. **跨用户安全隐患**：如果 workflow 使用 `process.cwd()` 获取路径，可能意外访问其他数据

## 相关代码

| 文件 | 说明 |
|------|------|
| `packages/workflow/src/workflow/runtime.ts` L74-88 | `runWorkflow` 不设置 cwd |
| `packages/scheduler/src/scheduler.ts` L133-134 | Scheduler 调用 `runWorkflow` |
| `apps/feishu/src/commands.ts` L238-245 | `/workflows run` 命令也调用 `runWorkflow`，同样没有 cwd 隔离 |

## 人类评估

严重问题，需要修复