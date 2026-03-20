/**
 * 对话日志的持久化数据结构
 *
 * ConversationLog 是对话快照的序列化格式，包含元数据和完整的消息历史。
 * 用于对话导出（log 命令）、恢复（--resume）和自动保存（--save-every-loop）。
 */

import type { DomainMessage } from "@n0n/types";

/** 对话日志元数据 */
export interface ConversationMetadata {
	/** 保存时间（ISO 8601） */
	savedAt: string;
	/** 工作区绝对路径 */
	workspace: string;
	/** 消息数量 */
	messageCount: number;
}

/** 对话日志完整结构 */
export interface ConversationLog {
	/** 格式版本，便于未来迁移 */
	version: 1;
	/** 元数据 */
	metadata: ConversationMetadata;
	/** 完整消息历史 */
	history: DomainMessage[];
}
