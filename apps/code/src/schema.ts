/**
 * Code Agent submit 结果 schema
 *
 * 定义 code 场景下 agent 的结束状态。
 * 与 interactive 模式不同：无 chat 类型（纯工具场景），
 * need_info 通过 submit userResponse 机制在 loop 内处理。
 */

import { z } from "zod";

export const CodeResultSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("completed"),
		summary: z.string().describe("完成摘要：做了什么"),
		files_changed: z.array(z.string()).describe("变更的文件列表"),
	}),
	z.object({
		type: z.literal("need_info"),
		message: z.string().describe("向用户说明需要什么信息"),
	}),
	z.object({
		type: z.literal("error"),
		error: z.string().describe("错误描述"),
		attempts: z.array(z.string()).describe("尝试过的方法"),
	}),
]);

export type CodeResult = z.infer<typeof CodeResultSchema>;
