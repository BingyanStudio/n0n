/**
 * FreeformPatchBackend — OpenAI Responses API + freeform apply_patch
 *
 * 通过 /v1/responses 端点发送 freeform custom tool，
 * 模型直接生成符合 Lark grammar 的 patch 纯文本，单次调用完成编辑。
 *
 * 要求：gpt-5.x 系列模型 + 支持 /v1/responses 端点的网关。
 */

import type {
	EditBackend,
	EditBackendCallbacks,
	EditBackendResult,
} from "../backend.ts";
import { APPLY_PATCH_TOOL } from "./grammar.ts";
import { applyPatchToSource, parsePatch } from "./parser.ts";

export interface FreeformPatchConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

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
		callbacks?.onEvent?.(0, { type: "thinking", text: "generating patch..." });

		const body = {
			model: this.config.model,
			input: [
				{
					role: "user",
					content: [
						"Here is the current file content:",
						"",
						"```",
						source,
						"```",
						"",
						`Edit intent: ${intent}`,
						"",
						"Apply the changes using the apply_patch tool.",
					].join("\n"),
				},
			],
			tools: [APPLY_PATCH_TOOL],
		};

		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (signal?.aborted) {
				return { content: source, feedback: null, error: "Aborted", rounds: 0 };
			}
			return {
				content: source,
				feedback: null,
				error: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
				rounds: 0,
			};
		}

		if (!res.ok) {
			const text = await res.text();
			return {
				content: source,
				feedback: null,
				error: `API ${res.status}: ${text.slice(0, 300)}`,
				rounds: 0,
			};
		}

		const json = (await res.json()) as {
			output: Array<{ type: string; name?: string; input?: string }>;
			usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
		};

		// 提取 patch 文本
		let patchText: string | null = null;
		for (const item of json.output) {
			if (item.type === "custom_tool_call" && item.name === "apply_patch") {
				patchText = item.input ?? null;
			}
		}

		if (!patchText) {
			return {
				content: source,
				feedback: null,
				error: "Model did not call apply_patch tool",
				rounds: 1,
			};
		}

		callbacks?.onToolResult?.(0, `apply_patch (${patchText.split("\n").length} lines)`);

		// 解析并应用
		const hunk = parsePatch(patchText);
		if ("error" in hunk) {
			return {
				content: source,
				feedback: null,
				error: `Patch parse error: ${hunk.error}`,
				rounds: 1,
			};
		}

		const result = applyPatchToSource(source, hunk);
		if (typeof result !== "string") {
			return {
				content: source,
				feedback: null,
				error: `Patch apply error: ${result.error}`,
				rounds: 1,
			};
		}

		const inTok = json.usage?.input_tokens ?? json.usage?.prompt_tokens ?? 0;
		const outTok = json.usage?.output_tokens ?? json.usage?.completion_tokens ?? 0;

		return {
			content: result,
			feedback: `[freeform-patch] ${inTok} in / ${outTok} out tokens`,
			error: null,
			rounds: 1,
		};
	}
}
