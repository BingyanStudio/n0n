/**
 * 对话日志的持久化数据结构
 *
 * ConversationLog 是对话快照的序列化格式，包含元数据和完整的消息历史。
 * 用于对话导出（log 命令）、恢复（--resume）和自动保存（--save-every-loop）。
 */

import type { DomainMessage } from "@n0n/types";

/**
 * 仅供人类阅读 JSON 文件时使用的辅助信息。
 * 程序不应消费此接口中的任何字段——所有派生数据应从 history 本身计算。
 */
export interface HumanReadableInfo {
	/** 保存时间（ISO 8601） */
	savedAt: string;
	/** 工作区绝对路径 */
	workspace: string;
	/** 保存时的消息数量（仅供人类阅读，程序应使用 history.length） */
	messageCount: number;
}

/** 对话日志完整结构 */
export interface ConversationLog {
	/** 格式版本，便于未来迁移 */
	version: 1;
	/** 仅供人类检查文件内容使用，程序不应消费此字段 */
	humanReadable: HumanReadableInfo;
	/** 完整消息历史 */
	history: DomainMessage[];
}
