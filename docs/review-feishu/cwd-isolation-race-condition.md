# runWorkflow 的 CWD 隔离存在进程级竞态条件

## 严重程度：高

## 问题描述

`runWorkflow` 修复了 CWD 隔离问题，但使用的是 `process.chdir()` — 这是**进程全局操作**，不是异步上下文隔离的。当多个 workflow 并发执行时，它们会互相覆盖 `process.cwd()`，导致 CWD 隔离完全失效。

## 问题代码

### `packages/workflow/src/workflow/runtime.ts`

```typescript
if (cwd) {
    const originalCwd = process.cwd();
    try {
        process.chdir(cwd);        // ← 修改整个进程的 cwd
        return await entryFn(args); // ← await 期间其他异步操作使用同一个 cwd
    } finally {
        process.chdir(originalCwd); // ← 恢复，但可能为时已晚
    }
}
```

### 并发场景

**场景 A：同一 scheduler 内不同任务同时触发**

```
tick()
  → entry "task-a" matches cron → runWorkflow(pathA, undefined, "/user-A/workspace")
  → entry "task-b" matches cron → runWorkflow(pathB, undefined, "/user-A/workspace")
  // task-a chdir → task-b chdir → task-a 的 entryFn 执行时 cwd 已被 task-b 修改
```

`executing` Set 只阻止**同名任务**重复触发，不同任务完全可以并发。

**场景 B：不同用户的 scheduler 同时触发**

每个用户的 scheduler 是独立的 `setInterval`，触发时间不协调：

```
用户 A scheduler tick → runWorkflow(cwd: "/feishu/userA")
用户 B scheduler tick → runWorkflow(cwd: "/feishu/userB")
// process.cwd() 在两个异步流之间反复切换
```

**场景 C：用户对话与 scheduler 重叠**

```
用户发消息 → runFeishuRound → agentLoop（长期运行，exec 工具依赖 cwd）
同时 scheduler tick → runWorkflow → process.chdir 修改 cwd
→ agentLoop 中的 exec 工具此时使用了错误的 cwd
```

## 影响

1. workflow 脚本中的相对路径 (`Bun.file("workflows/memory/...")`) 可能指向错误的用户目录
2. 跨用户数据访问：用户 A 的 workflow 可能读到用户 B 的文件
3. 间歇性故障，难以复现和诊断

## 建议修复

`process.chdir` 不适合在单进程多异步上下文中使用。推荐方案：

1. **子进程执行**：使用 `Bun.spawn` / `child_process.fork` 在独立进程中执行 workflow，设置 `cwd` 选项
2. **传参替代 chdir**：将 workspace 路径作为参数传给 entryFn，让 workflow 脚本使用绝对路径而非依赖 `process.cwd()`
3. **全局 CWD 锁**：最小化修复，使用互斥锁串行化所有 `process.chdir` 区间（牺牲并发性）

## 相关文件

| 文件 | 说明 |
|------|------|
| `packages/workflow/src/workflow/runtime.ts` | `runWorkflow` 使用 `process.chdir` |
| `packages/scheduler/src/scheduler.ts` | scheduler tick 并发调用 `runWorkflow` |
| `apps/feishu/src/index.ts` | 多用户各自有独立 scheduler 实例 |
| `apps/feishu/src/card-actions.ts` | 卡片操作 fire-and-forget 调用 `runWorkflow` |
