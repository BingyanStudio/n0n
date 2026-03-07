/**
 * 飞书卡片模块 — 统一导出
 */

export {
	buildCronListCard,
	buildProcessCard,
	buildTextCard,
	buildWorkflowListCard,
	type CronItem,
	chunkText,
	type LogKind,
	type LogLine,
	type RoundBlock,
	type WorkflowItem,
} from "./builder.ts";
export type { CardTemplate, FeishuCardContent } from "./types.ts";
