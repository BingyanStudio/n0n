/**
 * Fairy submit schema — 角色回复
 *
 * fairy 的 submit 只有一种类型：作为角色的回复。
 * 不区分 chat/completed/error，因为 fairy 始终以角色身份回应。
 */

import { z } from "zod";
export const FairyResponseSchema = z.object({
	reply: z.string().describe("角色的回复内容"),
});

export type FairyResponse = z.infer<typeof FairyResponseSchema>;
