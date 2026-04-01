/**
 * Code Agent submit 结果 schema
 *
 * 三种结束状态：
 * - completed：任务完成，简要汇报 + 可选 next-step 忏悔不足
 * - ask_user：向用户提问，需要用户选择/补充信息
 * - request_assist：请求用户协助（debug、外部信息等），附带检查列表
 *
 * 无 error 类型——code agent 应持续尝试，不主动放弃。
 * ask_user / request_assist 通过 submit userResponse 机制在 loop 内处理。
 */

import { z } from "zod";

const FollowUpOption = z.object({
	choice: z.string().describe("选项文本"),
	affect: z.string().describe("选择此项后的影响说明"),
});

const ChecklistItem = z.object({
	label: z.string().describe("检查项描述"),
	detail: z.string().optional().describe("补充说明或操作指引"),
});

export const CodeResultSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("completed"),
		summary: z.string().describe("完成摘要：做了什么"),
		next_step: z
			.string()
			.optional()
			.describe(
				"可选的后续步骤建议，坦诚说明可能存在的未完成的、做的不够好的部分",
			),
	}),
	z.object({
		type: z.literal("ask_user"),
		question: z.string().describe("向用户提出的具体问题"),
		options: z.array(FollowUpOption).describe("2-4 个选项供用户选择"),
	}),
	z.object({
		type: z.literal("request_assist"),
		content: z.string().describe("需要用户协助的具体内容"),
		checklist: z
			.array(ChecklistItem)
			.describe("问卷/检查列表，便于用户逐项执行并反馈结果"),
	}),
]);

export type CodeResult = z.infer<typeof CodeResultSchema>;
