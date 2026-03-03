/**
 * generate — 轻量级生成接口
 *
 * 与 delegateTask 的区别：
 * - 跳过意图增强（consultation）和 RAG 检索
 * - 仍走 agentLoop 路径，模型可自主使用工具（exec/write/reminder）
 * - 适用于简单的随机生成、格式化输出等轻量任务
 *
 * @example
 * ```ts
 * // 简单文本生成
 * const greeting = await generate("生成一句早安问候语");
 *
 * // 带 schema 的结构化生成
 * const result = await generate("生成一个随机用户资料", {
 *   schema: z.object({ name: z.string(), age: z.number() }),
 * });
 * ```
 */

import type { ZodType } from "zod";
import { agentLoop } from "../agent/index.ts";
import { ENV_INFO } from "../tools/index.ts";
import type { DomainMessage } from "../types/domain.ts";

export interface GenerateOptions<T = unknown> {
	/** Zod schema 校验结果，无 schema 时返回 string */
	schema?: ZodType<T>;
	/** 最大循环轮次（默认 15，比 delegateTask 更保守） */
	maxIterations?: number;
}

export interface GenerateResult<T = unknown> {
	result: T | null;
	report: string | null;
}

const GENERATE_SYSTEM_PROMPT = [
	"You are a helpful assistant executing a simple task.",
	"Complete the task and submit your result. Be concise and direct.",
	"You have access to tools (exec, write) if you need to fetch data or perform actions,",
	"but for simple generation tasks, just reason and submit directly.",
].join("\n");

/**
 * 轻量级生成：走 agentLoop 但跳过 consultation + RAG
 *
 * 模型仍可自主决定是否需要使用工具获取额外信息。
 */
export async function generate<T = unknown>(
	instruction: string,
	options?: GenerateOptions<T>,
): Promise<GenerateResult<T>> {
	const envLine = `Environment: OS=${ENV_INFO.os}, Shell=${ENV_INFO.shell}, CWD=${ENV_INFO.cwd}`;

	const history: DomainMessage[] = [
		{
			type: "system",
			content: `${GENERATE_SYSTEM_PROMPT}\n${envLine}`,
		},
		{
			type: "user_text",
			content: instruction,
		},
	];

	const result = await agentLoop<T>(history, {
		schema: options?.schema,
		maxIterations: options?.maxIterations ?? 15,
	});

	return {
		result: result.result,
		report: result.report,
	};
}
