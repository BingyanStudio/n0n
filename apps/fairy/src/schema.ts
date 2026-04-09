/**
 * Fairy submit schema — 角色回复
 *
 * fairy 的 submit 只有一种类型：作为角色的回复。
 * 不区分 chat/completed/error，因为 fairy 始终以角色身份回应。
 */

import { z } from "zod";

// COMMENT: 只有 reply 一个字段是故意的——fairy 的每次输出都是"角色回复"，
// 而不是结构化的任务结果。这与 code 模式的 submit schema（可以有 completed/ask_user
// 等多种类型）形成对比。但如果 fairy 要支持"主动行为"（定时触发的非回复动作），
// 可能需要扩展为 { type: "reply" | "action", ... } 的判别联合。
export const FairyResponseSchema = z.object({
	reply: z.string().describe("角色的回复内容"),
});

export type FairyResponse = z.infer<typeof FairyResponseSchema>;
