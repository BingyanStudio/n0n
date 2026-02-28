# Patch 1 — 审计修复 + 流程改进

> 日期：2026-02-28 | 对应审计：`docs/audit.md`

## 已修复

### 1. `delegateTask` 咨询步骤不再吞没致命错误
**位置**：[`delegate.ts`](../src/task/delegate.ts)
区分致命错误（401/403 直接 throw）和可恢复错误（降级 + 日志）。

### 2. 泛型 `TaskResult<T>` / `AgentResult<T>` 真正生效
**位置**：[`loop.ts`](../src/agent/loop.ts)、[`subagent.ts`](../src/agent/subagent.ts)、[`delegate.ts`](../src/task/delegate.ts)
整条链路 `AgentOptions<T>` → `agentLoop<T>` → `subagent<T>` → `delegateTask<T>` 的泛型与 `ZodType<T>` 绑定。`AgentResult.result` 类型改为 `T | null`。

### 3. `expectedReplaceTime` → `expectedMatches`
**位置**：[`definitions.ts`](../src/tools/definitions.ts)、[`write.ts`](../src/tools/write.ts)
参数名改为准确表达"期望匹配次数"。

### 4. exec 工具输出到控制台
**位置**：[`exec.ts`](../src/tools/exec.ts)
命令执行完毕后将 stdout/stderr 写到 process.stdout/stderr，用户可见。

### 5. 咨询结果持久化 + RAG 可检索
**位置**：[`delegate.ts`](../src/task/delegate.ts)、[`rag.ts`](../src/task/rag.ts)
- delegateTask Step 1 咨询完成后写入 `workflows/consult-result/<hash>.md`（带 frontmatter 元信息）
- RAG 的 `memory` 和 `all` 搜索空间包含 `workflows/consult-result/`
- 对齐 draft 原始设计：咨询→写文件→后续 RAG 可检索复用

### 6. 交互式循环保持 agent 上下文连续
**位置**：[`main.ts`](../src/main.ts)
- history 跨轮保留，不再每轮新建
- submit 后向 history 补上接受/拒绝反馈消息
- 模型保持完整对话上下文，轮次计数自然重置

### 7. System prompt 强化文件纪律和复用引导
**位置**：[`main.ts`](../src/main.ts) SYSTEM_PROMPT
- **禁止在 workflows/ 外写文件**
- **一个任务一个文件**，不创建多个变体
- **强制检查已有 workflow**，优先 import 复用而非重写
- **引导 skill 提取**：可复用部分先放 skills/，组合逻辑放 tasks/

## 待办

| 项目 | 原因 |
|------|------|
| 定期反思机制 | 后续实现 |
| RAG 中文分词 + 语义检索 | 后续迭代 |
| exec 安全边界 | 暂不处理 |
