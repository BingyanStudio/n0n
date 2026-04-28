/**
 * FreeformPatchBackend — OpenAI Responses API + 全 freeform 工具
 *
 * 闭环流程：apply_patch → view_file(验证) → submit(反馈)
 * 使用 step.ts 的单步执行组装多轮循环。
 */

import type { PatchOp } from "@n0n/types";
import type {
	EditBackend,
	EditBackendCallbacks,
	EditBackendResult,
} from "../backend.ts";
import systemPrompt from "./prompt.md" with { type: "text" };
import type { UsageInfo } from "./step.ts";
import { MAX_ROUNDS, step } from "./step.ts";

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
		const allPatches: PatchOp[] = [];
		const roundTokenUsage: Array<{ round: number; usage: UsageInfo | null }> =
			[];

		const conversation: unknown[] = [
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
					"",
					"The content inside <source_file>...</source_file> is the original file to be modified.",
					"The content inside <edit_intent>...</edit_intent> is the edit request you need to implement.",
					"Use apply_patch to apply changes, view_file to verify the result, and submit to finish.",
					"If the intent is impossible to execute, call submit with a score of 0/4 explaining why.",
				].join("\n"),
			},
		];

		for (let round = 0; round < MAX_ROUNDS; round++) {
			if (signal?.aborted) {
				return {
					content: current,
					feedback: null,
					error: "Aborted",
					rounds: round,
					patches: allPatches,
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
			allPatches.push(...result.patches);
			if (result.patchAppliedThisRound) patchApplied = true;

			if (result.error) {
				return {
					content: current,
					feedback: null,
					error: result.error,
					rounds: round + 1,
					patches: allPatches,
				};
			}

			if (result.hasSubmit) {
				feedback = result.feedback;
				return {
					content: current,
					feedback,
					error: patchApplied ? null : feedback ? null : "No patch applied",
					rounds: round + 1,
					patches: allPatches,
				};
			}
		}

		return {
			content: current,
			feedback,
			error: patchApplied ? null : `Did not submit within ${MAX_ROUNDS} rounds`,
			rounds: MAX_ROUNDS,
			patches: allPatches,
		};
	}
}
