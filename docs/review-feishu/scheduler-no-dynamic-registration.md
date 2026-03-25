# Scheduler 不支持动态注册新定时任务

## 问题描述

飞书服务启动时为所有已有用户的 schedule 启动了 scheduler，但**新用户/新 schedule 创建后不会被自动监控**，需要重启服务才能生效。

## 实际行为

### 启动时的初始化（`index.ts` L72-87）

```typescript
// 扫描所有已有用户目录
const allUserPaths = discoverAllUserPaths();
for (const userPaths of allUserPaths) {
    const schedules = await loadSchedules(userPaths);
    if (schedules.length > 0) {
        const handle = await startScheduler(userPaths);
        schedulerHandles.push(handle);
    }
}
```

这段代码**只在服务启动时执行一次**。

### 用户创建 schedule 后的情况

1. 用户 A 发消息："每天晚上九点跟我问好"
2. Agent 创建 `workflows/tasks/greet.ts` 和 `workflows/schedules/greet.mdc`
3. Agent 回复"已创建定时任务" ✅
4. **但 scheduler 没有监控用户 A 的 schedules 目录** ❌
5. 晚上九点到了，任务不会触发 ❌
6. 重启飞书服务后，`discoverAllUserPaths` 发现用户 A，`startScheduler` 启动 ✅

### 两种失败场景

**场景 A：新用户首次创建 schedule**

用户 A 之前从未使用过服务。服务启动时 `.runtime/feishu/` 下没有用户 A 的目录。用户 A 首次对话后 `resolveFeishuPaths` 创建了目录，Agent 写入 schedule 文件。但没有任何代码为用户 A 启动 scheduler。

**场景 B：已有用户新增 schedule（无历史 schedule）**

用户 B 之前有对话但没有定时任务。服务启动时 `loadSchedules` 返回空列表，未启动 scheduler。用户 B 后来创建了第一个 schedule，同样不会被监控。

**注意**：如果用户 C 启动时已有 schedule 且 scheduler 已启动，新增 schedule **可以** 被检测到——因为 `startScheduler` 每 60 秒重新 `loadSchedules` 扫描文件。问题仅出在没有 scheduler 实例的用户上。

## 为什么这是问题

1. **功能断裂**：Agent 告诉用户"已创建定时任务"，但任务实际不会触发，用户体验严重受损
2. **静默失败**：没有任何错误提示或日志告知 schedule 未被监控
3. **需要重启**：必须手动重启飞书服务才能让新 schedule 生效，对于线上服务不可接受

## 相关代码

| 文件 | 位置 | 说明 |
|------|------|------|
| `apps/feishu/src/index.ts` | L72-87 | 启动时一次性扫描并启动 scheduler |
| `apps/feishu/src/round.ts` | 全文件 | `runFeishuRound` 完成后没有触发 scheduler 注册 |
| `packages/scheduler/src/scheduler.ts` | `startScheduler` | 每 60s tick 重新扫描文件（已有 scheduler 的用户没问题） |
