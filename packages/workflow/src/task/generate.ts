/**
 * generate — 轻量级生成接口
 *
 * 跳过意图增强（consultation）和 RAG 检索，
 * 仍走 agentLoop 路径，模型可自主使用工具。
 */

import { agentLoop, buildToolsConfig, getRuntime } from "@n0n/core";
import type { BaseWorkspacePaths } from "@n0n/shared";
import { makeToolkit } from "@n0n/tools";
import type { DomainMessage } from "@n0n/types";
import type { ZodType } from "zod";

export interface GenerateOptions<T = unknown> {
	schema?: ZodType<T>;
	maxIterations?: number;
	paths: BaseWorkspacePaths;
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

export async function generate<T = unknown>(
	instruction: string,
	options: GenerateOptions<T>,
): Promise<GenerateResult<T>> {
	const history: DomainMessage[] = [
		{
			type: "system",
			content: GENERATE_SYSTEM_PROMPT,
		},
		{
			type: "generic_user_text",
			content: instruction,
		},
	];

	const runtime = getRuntime();
	const toolsConfig = buildToolsConfig(runtime, {
		workspace: options.paths.workspace,
		tempDir: options.paths.temp,
	});
	const toolkit = await makeToolkit(
		options?.schema,
		toolsConfig,
		runtime.client.modelId,
	);

	const result = await agentLoop<T>(history, {
		toolkit,
		schema: options?.schema,
		maxIterations: options?.maxIterations ?? 15,
	});

	return {
		result: result.result,
		report: result.report,
	};
}
