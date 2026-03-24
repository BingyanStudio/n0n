# Code Review 总结 — SSOT 与关注点分离

> 审查对象：当前 `fix/review-issues` 分支代码
> 审查基准：`docs/plan-remove-ai-sdk.md` 所描述的目标架构
> 审查重点：SSOT（Single Source of Truth）违背、关注点分离不足

## 总体评价

架构迁移已基本完成，核心分层（types → shared → llm / core / tools → apps）清晰，
依赖反转（core/tools 不依赖 llm）已实现。以下是发现的具体问题。

## 问题清单

| 编号 | 严重度 | 标题 |
|------|--------|------|
| 001 | 🔴 高 | SSE 解析逻辑在 OpenAI/Anthropic Client 中大量重复 |
| 002 | 🟡 中 | StreamRequest.promptMessages 旁路破坏了 LLMClient 抽象层 |
| 003 | 🟡 中 | cache 断点注入逻辑分散在两个 Client 中 |
| 004 | 🟡 中 | finishReason 字符串散落多处，缺少 SSOT 常量 |
| 005 | 🟡 中 | isAbortError 在 openai-client 和 anthropic-client 重复定义 |
| 006 | 🟡 中 | Anthropic max_tokens 硬编码 8192/4096，未走统一配置 |
| 007 | 🟢 低 | user_image 降级为纯文本，与 plan 设计不一致 |
| 008 | 🟢 低 | types 包含运行时代码 StreamAccumulator |
| 009 | 🟢 低 | OpenAI Client 中 flush 残余 buffer 逻辑与主循环重复 |
| 010 | 🟢 低 | LLMError 仅定义在 openai-client，Anthropic 复用时耦合 |
| 011 | 🟢 低 | config.ts 中 getModelId/getProviderType 辅助函数未被使用 |
