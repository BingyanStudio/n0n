# Scheduler 任务失败仍无法通知用户

## 严重程度：中

## 问题描述

原始 review 指出 scheduler 任务无错误隔离和并发控制。人类评估明确要求"错误应该提示而不应该静默处理"。修复添加了重复执行保护（`executing` Set）和更详细的错误日志前缀，但错误处理仍然仅限于 `console.error`，**用户无法得知定时任务执行失败**。

## 当前代码

### `packages/scheduler/src/scheduler.ts`

```typescript
runWorkflow(workflowPath, undefined, paths.workspace)
    .then((result) => {
        console.log(`[scheduler] ✅ ${entry.name}:`, ...);  // 成功：仅日志
    })
    .catch((err) => {
        console.error(`[scheduler] ❌ Workflow failed: ${entry.name}:`, err);  // 失败：仅日志
    })
    .finally(() => {
        executing.delete(entry.name);
    });
```

成功和失败都只有服务端日志，用户端无任何反馈。

## 影响

1. 用户创建定时任务后，如果脚本有 bug 或依赖的 API 不可用，任务持续静默失败
2. 用户以为任务在正常运行，实际上从未成功执行
3. 只有查看服务端日志才能发现问题，普通用户无权访问

## 修复已完成的部分

- ✅ `executing` Set 防止同一任务重复触发
- ✅ 错误日志增加 "Workflow failed:" / "Delegate task failed:" 前缀，便于区分
- ✅ `.catch()` + `.finally()` 模式替代 `.then(success, error)`，确保资源清理

## 仍需改进

- ❌ 任务成功/失败结果未推送给用户（如通过飞书消息通知）
- ❌ 没有失败重试机制
- ❌ 没有连续失败告警（如连续 3 次失败后禁用任务并通知用户）

## 建议

scheduler 的结果通知涉及跨层调用（scheduler 包 → feishu app），可通过回调机制实现：

```typescript
// startScheduler 接受可选的回调
interface SchedulerCallbacks {
    onSuccess?: (entry: ScheduleEntry, result: unknown) => void;
    onError?: (entry: ScheduleEntry, error: Error) => void;
}
```

feishu app 层注册回调，将结果通过飞书消息推送给用户。

## 相关文件

| 文件 | 说明 |
|------|------|
| `packages/scheduler/src/scheduler.ts` | scheduler 执行与错误处理 |
| `apps/feishu/src/index.ts` | scheduler 启动入口 |
