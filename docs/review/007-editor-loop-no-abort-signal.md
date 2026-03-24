# Review Issue #007: editor-loop 不支持 AbortSignal 传递

## 严重程度：中

## 位置
- `packages/tools/src/editor-loop.ts`

## 描述

Plan §9.3 验证计划明确要求：

> Ctrl+C 中断：abort signal 正确传递，流式输出干净终止

`LLMClient.stream()` 接口支持第二个 `signal?: AbortSignal` 参数。agent loop 在调用 `client.stream()` 时正确传递了 `options?.signal`。

然而 `editorLoop()` 函数：
1. 函数签名中没有 `signal` 参数
2. 调用 `editorClient.stream()` 时没有传 `signal`（L249 附近）
3. 内部循环没有 abort 检查

这意味着当用户 Ctrl+C 时，主 agent loop 可以正确终止，但如果当时正在执行 editor-loop（处于 edit 工具调用中），editor-loop 会继续运行直到完成或超时。

## 影响

用户 Ctrl+C 后，editor-loop 可能还会继续与 LLM 交互数轮才终止。

## 建议

1. `editorLoop()` 增加 `signal?: AbortSignal` 参数
2. 传递给 `editorClient.stream()`
3. 在每轮循环开头检查 `signal?.aborted`
