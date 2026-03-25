# Capability Context 硬编码且路径错误

## 问题描述

`round.ts` 中的 `buildFeishuCapabilityContext()` 硬编码了 feishu-bot skill 的路径为 `workflows/skills/feishu-bot`，这个路径在飞书模式下不正确。同时意图检测逻辑 `isWorkflowCreateIntent` 过于粗糙，误触率高。

## 实际行为

### 硬编码路径（`round.ts` L44-52）

```typescript
function buildFeishuCapabilityContext(): string {
    return [
        "## Feishu Source Context",
        "This task is triggered from Feishu message.",
        "If you are creating a workflow that needs user push notifications, use the skill:",
        "- workflows/skills/feishu-bot",  // ← 路径错误
    ].join("\n");
}
```

飞书模式下 skills 实际位于共享绝对路径 `.runtime/feishu/shared/skills/feishu-bot`，而非 `workflows/skills/feishu-bot`（这是 CLI 模式的路径格式）。

### 粗糙的意图检测（`round.ts` L33-41）

```typescript
function isWorkflowCreateIntent(text: string): boolean {
    return v.includes("workflow") || v.includes("工作流") ||
           v.includes("创建") || v.includes("新建") || v.includes("create");
}
```

"帮我创建一个文件" "新建一个目录" 等普通请求也会触发 capability context 注入。

## 为什么这是问题

1. **路径不一致**：Agent 按 `workflows/skills/feishu-bot` 寻找 skill 会找不到
2. **不可扩展**：新增 skill 需要手动修改硬编码
3. **误触发**：非 workflow 相关的"创建"请求也会注入不相关的 capability context，浪费 token 并可能误导 Agent
