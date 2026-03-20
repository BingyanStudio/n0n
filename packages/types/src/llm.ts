/**
 * LLM API 类型
 *
 * 所有 LLM 通信类型已迁移到 AI SDK：
 * - 消息类型：ai.ModelMessage（SystemModelMessage / UserModelMessage / AssistantModelMessage / ToolModelMessage）
 * - 工具定义：ai.Tool（通过 tool() + jsonSchema() 构造）
 * - 工具集：ai.ToolSet
 * - 非流式调用：@n0n/llm chatCompletion → ChatCompletionResult
 * - 流式调用：@n0n/llm chatCompletionStream → StreamEvent
 *
 * 此文件保留为空，以保持 types/index.ts 的 `export type * from "./llm.ts"` 不报错。
 */
