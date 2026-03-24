# Review Issue #001: finishReason 截断恢复逻辑未实现

## 严重程度：高

## 位置
- `packages/core/src/agent/loop.ts`

## 描述

Plan 文档 §1.2 明确指出当前架构的关键问题之一是：

> `finishReason` 在 agent loop 中**完全未检查**——模型输出因 `max_tokens` 截断时，工具调用 JSON 不完整，被静默丢弃

Plan §8 Step 7 也明确要求：

> 新增：`acc.finishReason === "length"` 时截断恢复逻辑

Plan §9.2 验证计划也列出了此场景：

> 截断恢复：设置低 `maxOutputTokens` 触发 `finishReason: "length"`，预期：工具调用 JSON 被 best-effort 修复，不静默丢弃

然而在实际实现中，`agent/loop.ts` **完全没有检查 `acc.finishReason`**。搜索整个 loop.ts，没有任何 `finishReason` 或 `length` 或 `truncat` 关键词。

StreamAccumulator 已经正确累积了 `finishReason`（在 `client.ts` 中），但 agent loop 从未读取它。

## 影响

当模型输出因 `max_tokens` 被截断时：
1. 工具调用的 JSON 参数不完整
2. `parseToolCalls` 中的 `JSON.parse` 失败，参数被标记为 `_parseError: true`
3. `isValidToolCall` 过滤掉这些 tool call
4. agent 进入 idle 计数而非尝试恢复
5. 最终因 idle 超限终止，用户无任何截断提示

## 建议

在 `renderer.contentEnd()` 之后、`assistantMsg` 处理之前，检查 `acc.finishReason`：
- `"length"` → 尝试 best-effort JSON 修复或向用户报告截断
- `"content_filter"` → 明确告知用户内容被过滤
