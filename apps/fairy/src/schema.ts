/**
 * Fairy progress schema — 角色回复
 *
 * fairy 的 progress 只有一种 status：reply。
 * content 即角色的回复内容。
 */

import { z } from "zod";

export const FairyProgressSchema = z.object({
	status: z.literal("reply"),
	content: z.string(),
});

export type FairyProgressResult = z.infer<typeof FairyProgressSchema>;
