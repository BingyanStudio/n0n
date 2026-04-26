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
		options: z
			.string()
			.describe(
				"DSL 格式：每个选项以 `## ` 开头，下一行写详细说明；2-4 个选项供用户选择。示例：\n## 方案 A：直接修改\n代码改动量最小，但可能与未来功能冲突\n## 方案 B：提取为单独模块\n更清晰但需要额外重构",
			),
	}),
	z.object({
		type: z.literal("request_assist"),
		content: z.string().describe("需要用户协助的具体内容"),
		checklist: z
			.string()
			.describe(
				"使用 DSL 格式，每个检查项以 `## ` 开头，可选详情在下一行。示例：\n## 运行测试\n重点关注测试套件的继承关系\n## 检查 diff\n确认只修改了目标文件",
			),
	}),
]);

export type CodeResult = z.infer<typeof CodeResultSchema>;
