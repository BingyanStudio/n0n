/**
 * 对话日志模块 — 对话持久化与恢复
 *
 * 提供对话历史的序列化（导出 JSON）和反序列化（从 JSON 恢复）功能。
 * 不依赖 core 或具体 app，仅依赖 @n0n/types 中的 DomainMessage 类型。
 */

export {
	generateLogFileName,
	loadConversation,
	saveConversation,
} from "./conversation-log.ts";
export type {
	ConversationLog,
	ConversationMetadata,
} from "./types.ts";
