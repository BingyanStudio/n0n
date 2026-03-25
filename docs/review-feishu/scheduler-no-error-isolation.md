# Scheduler 任务无错误隔离和并发控制

## 问题描述

Scheduler 在 tick 中遍历所有 enabled 的 schedule entry，匹配到 cron 时间后直接 fire-and-forget 执行。没有并发限制、没有执行时间保护、错误处理不完整。

## 实际行为

### 无并发控制（`scheduler.ts` tick 函数）

```typescript
for (const entry of entries) {
    if (!entry.enabled) continue;
    if (!cronMatches(fields, now)) continue;
    // 直接 fire-and-forget，不限制并发数
    runWorkflow(workflowPath).then(...)
    // 或
    delegateTask(entry.prompt, { paths }).then(...)
}
```

如果用户创建了 10 个同时触发的 schedule（如都设为 `0 9 * * *`），它们会同时启动 10 个 agentLoop，每个都调用 LLM API。

### 无执行时间追踪

没有记录上次执行时间。如果一个 workflow 执行超过 60 秒（tick 间隔），下一次 tick 可能再次触发同一个 schedule，导致重复执行。

### delegateTask 无 workspace 上下文传递

```typescript
delegateTask(entry.prompt, { paths }).then(...)
```

`delegateTask` 内部会创建 agentLoop，但这些 agentLoop 没有 renderer（用户看不到执行过程），也没有办法将执行结果推送给用户。执行完后只有 `console.log`。

## 为什么这是问题

1. **资源争抢**：多个 workflow 同时执行，LLM API 并发可能导致 rate limit
2. **重复执行**：长耗时 workflow 可能被重复触发
3. **结果不可达**：scheduler 触发的任务完成后无法通知用户（只有 console.log）
4. **无失败重试**：失败的任务只有 console.error，不会重试或通知

## 人类评估

确实需要修复。不过 scheduler 中间步骤并不对用户展示，计划任务仅仅需要产出结果。至于错误应该提示而不应该静默处理。