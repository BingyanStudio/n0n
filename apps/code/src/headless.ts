/**
 * Headless 模式 — 单次执行后退出，用于 Harbor 评测等非交互场景
 *
 * 接收一条 instruction，驱动 agentLoop 执行到 completed 或超时，
 * 不等待用户输入，ask_user/request_assist 自动回复 "proceed with your best judgment"。
 *
 * 输出 JSON 结果到 stdout，日志输出到 stderr。
 */

import { agentLoop, PlainRenderer } from "@n0n/core";
import {
	type BaseWorkspacePaths,
	formatAgentsMdPrompt,
	loadAgentsMd,
} from "@n0n/shared";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import codePromptText from "./prompts/code.md" with { type: "text" };
import { buildFewshotMessages } from "./fewshot.ts";
import { type CodeResult, CodeResultSchema } from "./schema.ts";

export interface HeadlessOptions {
	/** 任务指令 */
	instruction: string;
	/** 工作目录路径 */
	paths: BaseWorkspacePaths;
	/** 最大迭代次数 */
	maxIterations?: number;
	/** 超时（毫秒） */
	timeoutMs?: number;
	/** 额外的 system prompt 前缀 */
	systemPromptPrefix?: string;
}

export interface HeadlessResult {
	/** agent 是否成功完成 */
	success: boolean;
	/** agent 的 submit 结果 */
	result: CodeResult | null;
	/** agent 的 report */
	report: string | null;
	/** 循环轮次 */
	rounds: number;
	/** 耗时（毫秒） */
	durationMs: number;
	/** 错误信息（如果有） */
	error: string | null;
}

function buildEnvironmentSection(workspace: string): string {
	return [
		"",
		"# Environment",
		"",
		`- Working directory: \`${workspace}\``,
		"- All tool paths resolve relative to this directory.",
		"",
		"Use relative paths (e.g. `src/utils.ts`) — they will resolve correctly.",
		"Read existing code before modifying it to understand project structure.",
	].join("\n");
}

function buildHeadlessHint(): string {
	return [
		"You are running in HEADLESS mode — there is no human to interact with.",
		"You MUST complete the task autonomously. Do NOT submit `ask_user` or `request_assist`.",
		"If uncertain, make your best judgment and proceed.",
		"First, use `exec` to understand the codebase, then implement the fix, then verify.",
		"Submit `completed` when done.",
	].join("\n");
}

async function gatherContext(workspace: string): Promise<string | null> {
	const parts: string[] = [];
	try {
		const gitStatus = Bun.spawnSync(["git", "status", "--short"], {
			cwd: workspace,
		});
		const status = gitStatus.stdout.toString().trim();
		if (status) {
			parts.push(`<git_status>\n${status}\n</git_status>`);
		}
		const gitBranch = Bun.spawnSync(["git", "branch", "--show-current"], {
			cwd: workspace,
		});
		const branch = gitBranch.stdout.toString().trim();
		if (branch) {
			parts.push(`<git_branch>${branch}</git_branch>`);
		}
	} catch {}
	return parts.length > 0 ? parts.join("\n") : null;
}

function injectUserResponse(history: DomainMessage[], response: string): void {
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (msg?.type === "tool_result" && "tool" in msg && msg.tool === "submit") {
			// TODO
			// msg as SubmitToolResult → 应通过判别联合窄化 (msg.tool === "submit") 自动收窄类型
			// ODOT
			(msg as SubmitToolResult).userResponse = response;
			return;
		}
	}
}

export async function runHeadless(
	options: HeadlessOptions,
): Promise<HeadlessResult> {
	const {
		instruction,
		paths,
		maxIterations = 100,
		timeoutMs = 900_000, // 15 分钟默认
		systemPromptPrefix,
	} = options;

	const startTime = Date.now();

	// 构建 system prompt
	let systemPrompt = codePromptText;
	if (systemPromptPrefix) {
		systemPrompt = `${systemPromptPrefix}\n\n${systemPrompt}`;
	}
	const agentsMd = await loadAgentsMd(paths.workspace);
	if (agentsMd) {
		systemPrompt += `\n\n${formatAgentsMdPrompt(agentsMd)}`;
	}
	systemPrompt += buildEnvironmentSection(paths.workspace);

	const renderer = new PlainRenderer();
	const abortController = new AbortController();

	// 超时控制
	const timer = setTimeout(() => abortController.abort(), timeoutMs);

	let history: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
		...buildFewshotMessages(),
		{
			type: "user_input",
			content: instruction,
			context: await gatherContext(paths.workspace),
			hint: buildHeadlessHint(),
		},
	];

	let rounds = 0;
	const MAX_NEED_INFO_RETRIES = 3;
	let needInfoCount = 0;

	try {
		while (true) {
			const agentResult = await agentLoop<CodeResult>(history, {
				maxIterations,
				renderer,
				confirmFn: async () => "y",
				schema: CodeResultSchema,
				signal: abortController.signal,
				toolsWorkspace: {
					workspace: paths.workspace,
					tempDir: paths.temp,
				},
			});

			history = agentResult.history;
			rounds++;
			const ir = agentResult.result;

			if (ir == null) {
				// Agent 异常终止
				return {
					success: false,
					result: null,
					report: agentResult.report ?? null,
					rounds,
					durationMs: Date.now() - startTime,
					error: agentResult.report ?? "Agent terminated without result",
				};
			}

			if (ir.type === "completed") {
				return {
					success: true,
					result: ir,
					report: agentResult.report ?? null,
					rounds,
					durationMs: Date.now() - startTime,
					error: null,
				};
			}

			if (ir.type === "ask_user" || ir.type === "request_assist") {
				needInfoCount++;
				if (needInfoCount >= MAX_NEED_INFO_RETRIES) {
					return {
						success: false,
						result: ir,
						report:
							"Agent requested assistance too many times in headless mode",
						rounds,
						durationMs: Date.now() - startTime,
						error: `Agent requested help ${needInfoCount} times in headless mode`,
					};
				}
				// 自动回复，让 agent 继续
				injectUserResponse(
					history,
					"You are in headless/autonomous mode. There is no human available. Proceed with your best judgment and complete the task.",
				);
			}
		}
	} catch (err) {
		const message =
			err instanceof Error ? err.message : String(err ?? "Unknown error");
		return {
			success: false,
			result: null,
			report: null,
			rounds,
			durationMs: Date.now() - startTime,
			error: abortController.signal.aborted
				? `Timeout after ${timeoutMs}ms`
				: message,
		};
	} finally {
		clearTimeout(timer);
	}
}
