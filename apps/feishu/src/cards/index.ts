/**
 * 飞书卡片模块 — 统一导出
 */

export {
	buildProcessCard,
	buildTextCard,
	chunkText,
	type LogEntry,
	type LogEntryKind,
	mkCollapsiblePanel,
} from "./builder.ts";
export type { CardHeaderTemplate, FeishuCardContent } from "./types.ts";
