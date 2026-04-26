/**
 * FreeformPatchBackend — OpenAI Responses API + 全 freeform 工具
 *
 * 闭环流程：apply_patch → view_file(验证) → submit(反馈)
 * 使用 step.ts 的单步执行组装多轮循环。
 */

import type {
	EditBackend,
	EditBackendCallbacks,
	EditBackendResult,
} from "../backend.ts";
import { step, MAX_ROUNDS } from "./step.ts";
import type { UsageInfo } from "./step.ts";
import systemPrompt from "./prompt.md" with { type: "text" };

// ── 重新导出 ResponsesClient 类型 ──

export interface ResponsesClient {
	create(
		input: unknown[],
		tools: unknown[],
		signal?: AbortSignal,
	): Promise<ResponsesResult | { error: string }>;
}

export interface ResponsesResult {
	output: ResponseItem[];
	usage?: UsageInfo;
}

interface ResponseItem {
	type: string;
	call_id?: string;
	name?: string;
	input?: string;
}

export class FreeformPatchBackend implements EditBackend {
	readonly name = "freeform-patch";
	private readonly client: ResponsesClient;

	constructor(client: ResponsesClient) {
		this.client = client;
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
		const roundTokenUsage: Array<{ round: number; usage: UsageInfo | null }> = [];

		const conversation: unknown[] = [
			{ role: "developer", content: systemPrompt },
			{
				role: "user",
				content: `<source_file>\n${source}\n</source_file>\n\n<edit_intent>\n${intent}\n</edit_intent>`,
			},
		];

		for (let round = 0; round < MAX_ROUNDS; round++) {
			if (signal?.aborted) {
				return {
					content: current,
					feedback: null,
					error: "Aborted",
					rounds: round,
				};
			}

			const result = await step({
				conversation,
				content: current,
				client: this.client,
				round,
				patchAlreadyApplied: patchApplied,
				signal,
				onEvent: callbacks?.onEvent,
				onToolResult: callbacks?.onToolResult,
			});

			// 记录 token 用量
			roundTokenUsage.push({ round, usage: result.tokenUsage });

			// 更新状态
			current = result.content;
			if (result.patchAppliedThisRound) patchApplied = true;

			if (result.error) {
				return {
					content: current,
					feedback: null,
					error: result.error,
					rounds: round + 1,
				};
			}

			if (result.hasSubmit) {
				feedback = result.feedback;
				return {
					content: current,
					feedback,
					error: patchApplied ? null : feedback ? null : "No patch applied",
					rounds: round + 1,
				};
			}
		}

		return {
			content: current,
			feedback,
			error: patchApplied ? null : `Did not submit within ${MAX_ROUNDS} rounds`,
			rounds: MAX_ROUNDS,
		};
	}
}
