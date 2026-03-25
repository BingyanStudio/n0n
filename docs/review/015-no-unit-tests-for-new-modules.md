# Review Issue #015: 新核心模块缺少单元测试

## 严重程度：高

## 位置
- `packages/shared/src/format-prompt.ts` — 无测试
- `packages/llm/src/openai-client.ts` — 无测试
- `packages/llm/src/anthropic-client.ts` — 无测试
- `packages/types/src/client.ts` (StreamAccumulator) — 无测试

## 描述

Plan §9 验证计划列出了详细的测试矩阵，§8 Step 2 明确要求：

> **验证**：单元测试——输入 DomainMessage[]，断言输出 PromptMessage[] 的 role 和 content 正确

实际实现中，除了已有的 `cache.test.ts` 外，所有新增模块均无单元测试：

1. **format-prompt.ts** — 纯函数，非常适合单元测试。应覆盖：
   - 各种 DomainMessage 类型的转换
   - 连续 system 消息合并
   - XML tag 风格适配
   - tool result 各分支

2. **StreamAccumulator** — 状态类，应覆盖：
   - 基本事件累积
   - tool_call_delta 的 index 合并
   - thinking_signature 处理
   - toMessage() 输出

3. **OpenAI/Anthropic Client** — 可通过 mock fetch 测试：
   - SSE 解析正确性
   - 消息格式转换
   - 错误处理
   - 重试逻辑

## 影响

缺少测试意味着回归风险高。三个修复 commit (7a1a206, 05163d0, cb40807) 都是在端到端测试中发现的 bug，如果有单元测试，部分可以更早发现。

## 建议

为关键纯函数模块（format-prompt、StreamAccumulator）添加单元测试。SSE 解析可通过 mock ReadableStream 测试。
