# Scheduler 任务失败仍无法通知用户

## 严重程度：中

## 状态：✅ 已修复 (9948044)

## 问题描述

scheduler 任务成功/失败仅 `console.log`/`console.error`，用户无法得知定时任务的执行状态。

## 修复方案

在 `@n0n/scheduler` 包新增 `SchedulerCallbacks` 接口：

```typescript
interface SchedulerCallbacks {
    onTaskComplete?: (entry, result) => void | Promise<void>;
    onTaskError?: (entry, error) => void | Promise<void>;
}
```

飞书端实现回调，通过卡片消息向用户推送：
- 任务成功：绿色卡片 `✅ 定时任务完成: <name>`
- 任务失败：红色卡片 `❌ 定时任务失败: <name>`

## 相关文件

| 文件 | 说明 |
|------|------|
| `packages/scheduler/src/scheduler.ts` | 新增 SchedulerCallbacks 接口 |
| `apps/feishu/src/index.ts` | 实现飞书通知回调 |
