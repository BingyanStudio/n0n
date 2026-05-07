/**
 * Fairy progress 工具配置
 *
 * fairy 只有一种 status：reply（角色回复）
 */

import type { ProgressStatusConfig } from "@n0n/tools";

export const fairyProgressConfig: ProgressStatusConfig[] = [
	{
		value: "reply",
		statusDesc: "角色回复完毕。",
		contentDesc: "角色的回复内容。",
	},
];
