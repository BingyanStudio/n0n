/**
 * Code Agent submit 结果 schema
 *
 * 两种结束状态：
 * - completed：任务完成，附带变更文件列表
 * - need_info：需要用户选择/补充信息，必须提供选项
 *
 * 无 error 类型——code agent 应持续尝试，不主动放弃。
 * need_info 通过 submit userResponse 机制在 loop 内处理。
 */

import { z } from "zod";

const FollowUpOption = z.object({
	choice: z.string().describe("选项文本"),
	affect: z.string().describe("选择此项后的影响说明"),
});

export const CodeResultSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("completed"),
		summary: z.string().describe("完成摘要：做了什么"),
		files_changed: z.array(z.string()).describe("变更的文件列表"),
	}),
	z.object({
		type: z.literal("need_info"),
		question: z.string().describe("向用户提出的具体问题"),
		options: z.array(FollowUpOption).describe("2-4 个选项供用户选择"),
	}),
]);

export type CodeResult = z.infer<typeof CodeResultSchema>;
