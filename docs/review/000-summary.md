# Review 汇总 — refactor/remove-ai-sdk

## 总体评价

此次重构总体质量较高，8 个 Step 按 Plan 依赖顺序执行，commit 粒度清晰，3 个修复 commit 也说明有端到端测试验证。核心设计（LLMClient 接口、StreamEvent、ToolDefinition 回退、format-prompt 分离）实现到位。

## 问题分布

| 严重程度 | 数量 | 编号 |
|---------|------|------|
| 高 | 2 | #001, #015 |
| 中 | 5 | #005, #006, #007, #009, #011, #013 |
| 低 | 8 | #002, #003, #004, #008, #010, #012, #014, #016, #017 |

## 高优先级问题

### #001 — finishReason 截断恢复逻辑未实现
Plan 的核心动机之一（§1.2）是修复 finishReason 未检查的问题，Plan Step 7 明确要求添加截断恢复逻辑，但 agent loop 中完全没有实现。StreamAccumulator 已正确累积 finishReason，但 loop 从未读取。

### #015 — 新核心模块缺少单元测试
format-prompt（纯函数）、StreamAccumulator（状态类）、两个 Client 的 SSE 解析和消息格式转换均无测试。Plan §9 列出了详细测试矩阵但未落地。三个修复 commit 证明了端到端测试发现 bug 的能力，但这些 bug 若有单元测试可更早发现。

## 中优先级问题

- **#011** — tool_arg_error.schema 恢复了数据存储但 format-prompt 未将 schema 包含在提示词中，模型仍看不到
- **#013** — @n0n/core/runtime.ts 仍直接 import @n0n/llm，依赖反转未完全实现
- **#005** — OpenAI usage 可能因 chunk 顺序问题丢失
- **#006** — Anthropic max_tokens 硬编码，thinking 大预算场景可能超限
- **#007** — editor-loop 不支持 AbortSignal，Ctrl+C 无法终止编辑中的 LLM 调用
- **#009** — OpenAI litellm 路径的 cache 注入没有 budget 限制

## 低优先级问题（代码卫生）

- **#002, #003, #004** — 残留旧注释和死代码（ThinkingProviderOptions、anthropicCacheControl、旧导出）
- **#008** — 两个 Client 的 complete() 重试逻辑不统一
- **#010** — user_image 降级为纯文本占位
- **#012** — SSE buffer 残留数据理论上可能丢失
- **#014** — Anthropic 空 system 数组
- **#016** — promptMessages 旁路是 Plan 外设计变更
- **#017** — node_modules 残留

## 正面评价

1. **commit 粒度优秀** — 每个 Step 一个 commit，消息清晰，改动范围与 Plan 一致
2. **修复 commit 证明了实践验证** — baseUrl 双 /v1、Anthropic tool_call_delta index、thinking signature、cache overflow 4 个 bug 都在端到端测试中发现并修复
3. **@n0n/tools 依赖反转完全实现** — 不再依赖 @n0n/llm
4. **format-prompt 模块清晰** — 纯函数，职责边界明确
5. **SSE 解析实现健壮** — 正确处理了 abort、网络错误、API 错误等边界场景
6. **Anthropic thinking signature 全链路** — 从 SSE 解析到 DomainMessage 到 PromptMessage 到 API 消息格式的完整传递
