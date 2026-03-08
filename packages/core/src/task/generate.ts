/**
 * generate — 轻量级生成接口
 *
 * 跳过意图增强（consultation）和 RAG 检索，
 * 仍走 agentLoop 路径，模型可自主使用工具。
 */

import { initToolsConfig } from "@n0n/tools";
import type { DomainMessage } from "@n0n/types";
import type { ZodType } from "zod";
import { agentLoop } from "../agent/loop.ts";
import {
	config,
	getCurrentPaths,
	type PathConfig,
	resolvePaths,
} from "../config.ts";

export interface GenerateOptions<T = unknown> {
	schema?: ZodType<T>;
	maxIterations?: number;
	pathConfig?: PathConfig;
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
	options?: GenerateOptions<T>,
): Promise<GenerateResult<T>> {
	const resolvedPaths = options?.pathConfig
		? resolvePaths(options.pathConfig)
		: getCurrentPaths();

	if (options?.pathConfig) {
		initToolsConfig({
			security: config.security,
			agent: config.agent,
			workspace: resolvedPaths.workspace,
			tempDir: resolvedPaths.temp,
		});
	}

	const IS_WINDOWS = process.platform === "win32";
	const os = IS_WINDOWS ? "Windows" : process.platform;
	const shell = IS_WINDOWS ? "cmd" : "sh";
	const envLine = `Environment: OS=${os}, Shell=${shell}, CWD=${resolvedPaths.workspace}`;

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
