/**
 * 交互模式 submit 结果 schema
 *
 * 定义交互模式下 agent 的四种结束状态。
 * 放在 core 中，供 cli 和 feishu 共享。
 */

import { z } from "zod";

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
