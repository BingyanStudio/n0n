/**
 * 对话日志模块 — 对话持久化与恢复
 *
 * 提供对话历史的序列化（导出 JSON）和反序列化（从 JSON 恢复）功能。
 * 不依赖 core 或具体 app，仅依赖 @n0n/types 中的 DomainMessage 类型。
 *
 * 为什么放在 shared 而非 core：
 * - core 保持纯净，只负责 agent loop
 * - 多个 app（cli、code、fairy）均可复用
 * - 逻辑简单且仅依赖 @n0n/types，与 shared 定位一致
 */

export {
	generateLogFileName,
	loadConversation,
	saveConversation,
} from "./conversation-log.ts";
export type {
	ConversationLog,
	HumanReadableInfo,
} from "./types.ts";
