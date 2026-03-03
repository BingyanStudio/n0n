/**
 * 交互模式 submit 结果 schema
 *
 * 定义交互模式下 agent 的四种结束状态。
 */

import { z } from "zod";

/**
 * 交互模式下 agent 的四种结束状态：
 * - chat: 对话式回复（打招呼、闲聊、讨论等非任务场景）
 * - need_info: 需要用户补充信息才能继续
 * - completed: 任务成功完成
 * - error: 不可恢复的错误（超过重试上限、陷入循环等）
 */
export const InteractiveResultSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("chat"),
		message: z.string().describe("对话回复内容"),
	}),
	z.object({
		type: z.literal("need_info"),
		message: z.string().describe("向用户说明需要什么信息"),
	}),
	z.object({
		type: z.literal("completed"),
		result: z.string().describe("任务产出（文件路径、回答文本等）"),
		summary: z.string().optional().describe("简短的完成摘要"),
	}),
	z.object({
		type: z.literal("error"),
		error: z.string().describe("错误描述"),
	}),
]);

export type InteractiveResult = z.infer<typeof InteractiveResultSchema>;
