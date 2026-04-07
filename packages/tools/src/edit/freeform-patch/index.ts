/**
 * FreeformPatchBackend — OpenAI Responses API + freeform apply_patch
 *
 * 闭环编辑循环：
 * 1. 模型调用 apply_patch 生成 patch + submit 反馈（首轮只提供这两个工具）
 * 2. 如果 patch 应用失败，追加 view_file 工具供模型验证后重试
 * 3. 模型调用 submit 提交反馈评分（驱动主模型 ICL）
 *
 * 要求：gpt-5.x 系列模型 + 支持 /v1/responses 端点的网关。
 */

import type {
	EditBackend,
	EditBackendCallbacks,
	EditBackendResult,
} from "../backend.ts";
import {
	APPLY_PATCH_TOOL,
	SUBMIT_TOOL,
	VIEW_FILE_TOOL,
} from "./grammar.ts";
import { applyPatchToSource, parsePatch } from "./parser.ts";
import systemPrompt from "./prompt.md" with { type: "text" };

export interface FreeformPatchConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

const MAX_ROUNDS = 5;

// 首轮工具：apply_patch + submit（不含 view_file，避免模型跳过编辑直接查看）
const FIRST_ROUND_TOOLS = [APPLY_PATCH_TOOL, SUBMIT_TOOL];
// 后续轮工具：追加 view_file 供验证和重试
const ALL_TOOLS = [APPLY_PATCH_TOOL, VIEW_FILE_TOOL, SUBMIT_TOOL];

// ── Responses API 类型 ──

interface ResponseItem {
	type: string;
	id?: string;
	call_id?: string;
	name?: string;
	input?: string;
	arguments?: string;
}

interface ResponsesResult {
	output: ResponseItem[];
}

// ── 后端实现 ──

export class FreeformPatchBackend implements EditBackend {
	readonly name = "freeform-patch";
	private readonly config: FreeformPatchConfig;
	private readonly apiUrl: string;

	constructor(config: FreeformPatchConfig) {
		this.config = config;
		const base = config.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
		this.apiUrl = `${base}/v1/responses`;
	}

	async execute(
		source: string,
		intent: string,
		callbacks?: EditBackendCallbacks,
		signal?: AbortSignal,
	): Promise<EditBackendResult> {
		let current = source;
		let feedback: string | null = null;
		let patchApplied = false;

		const input: unknown[] = [
			{ role: "developer", content: systemPrompt },
			{
				role: "user",
				content: [
					"<source_file>",
					source,
					"</source_file>",
					"",
					"<edit_intent>",
					intent,
					"</edit_intent>",
				].join("\n"),
			},
		];

		for (let round = 0; round < MAX_ROUNDS; round++) {
			if (signal?.aborted) {
				return { content: current, feedback: null, error: "Aborted", rounds: round };
			}

			callbacks?.onEvent?.(round, { type: "thinking", text: `round ${round + 1}...` });

			// 首轮不含 view_file，后续轮加入
			const tools = round === 0 ? FIRST_ROUND_TOOLS : ALL_TOOLS;

			const json = await this.callApi(input, tools, signal);
			if ("error" in json && typeof json.error === "string") {
				return { content: current, feedback, error: json.error, rounds: round + 1 };
			}

			let hasSubmit = false;
			const response = json as ResponsesResult;

			for (const item of response.output) {
				// apply_patch (freeform)
				if (item.type === "custom_tool_call" && item.name === "apply_patch") {
					const patchText = item.input ?? "";
					callbacks?.onToolResult?.(round, `apply_patch (${patchText.split("\n").length} lines)`);

					const hunk = parsePatch(patchText);
					if ("error" in hunk) {
						input.push(item);
						input.push({
							type: "custom_tool_call_output",
							call_id: item.call_id,
							output: `Error: ${hunk.error}. Please fix and try again.`,
						});
						continue;
					}

					const result = applyPatchToSource(current, hunk);
					if (typeof result !== "string") {
						input.push(item);
						input.push({
							type: "custom_tool_call_output",
							call_id: item.call_id,
							output: `Error: ${result.error}. Call view_file to see current content, then retry.`,
						});
						continue;
					}

					current = result;
					patchApplied = true;
					input.push(item);
					input.push({
						type: "custom_tool_call_output",
						call_id: item.call_id,
						output: "OK: Patch applied successfully.",
					});
				}

				// view_file (function)
				if (item.type === "function_call" && item.name === "view_file") {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(item.arguments ?? "{}"); } catch {}

					const lines = current.split("\n");
					const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
					const endLine = typeof args.end_line === "number" ? args.end_line : undefined;

					let content: string;
					if (startLine !== undefined || endLine !== undefined) {
						const s = Math.max(1, startLine ?? 1);
						const e = Math.min(lines.length, endLine ?? lines.length);
						const numbered = lines.slice(s - 1, e).map((l, i) => `${s + i}| ${l}`).join("\n");
						content = `<source_file lines="${s}-${e}" total="${lines.length}">\n${numbered}\n</source_file>`;
						callbacks?.onToolResult?.(round, `view_file → L${s}-${e}`);
					} else {
						content = `<source_file>\n${current}\n</source_file>`;
						callbacks?.onToolResult?.(round, `view_file → ${lines.length} lines`);
					}

					input.push(item);
					input.push({
						type: "function_call_output",
						call_id: item.call_id,
						output: content,
					});
				}

				// submit (function)
				if (item.type === "function_call" && item.name === "submit") {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(item.arguments ?? "{}"); } catch {}

					feedback = typeof args.feedback === "string" ? args.feedback : null;
					hasSubmit = true;
					callbacks?.onToolResult?.(round, feedback ? `submit\n  ${feedback}` : "submit");
				}
			}

			if (hasSubmit) {
				return {
					content: current,
					feedback,
					error: patchApplied ? null : (feedback ? null : "No patch applied"),
					rounds: round + 1,
				};
			}
		}

		// 循环结束仍未 submit，如果 patch 已应用则视为成功
		return {
			content: current,
			feedback,
			error: patchApplied ? null : `Did not submit within ${MAX_ROUNDS} rounds`,
			rounds: MAX_ROUNDS,
		};
	}

	private async callApi(
		input: unknown[],
		tools: unknown[],
		signal?: AbortSignal,
	): Promise<ResponsesResult | { error: string }> {
		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify({ model: this.config.model, input, tools }),
				signal,
			});
		} catch (err) {
			if (signal?.aborted) return { error: "Aborted" };
			return { error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` };
		}

		if (!res.ok) {
			const text = await res.text();
			return { error: `API ${res.status}: ${text.slice(0, 300)}` };
		}

		return (await res.json()) as ResponsesResult;
	}
}
