/**
 * FreeformPatchBackend — OpenAI Responses API + 全 freeform 工具
 *
 * 闭环流程：apply_patch → view_file(验证) → submit(反馈)
 * 所有工具均使用 grammar，无 JSON schema 开销。
 */

import type {
	EditBackend,
	EditBackendCallbacks,
	EditBackendResult,
} from "../backend.ts";
import { ALL_TOOLS, FIRST_ROUND_TOOLS } from "./grammar.ts";
import { applyPatchToSource, parsePatch } from "./parser.ts";
import systemPrompt from "./prompt.md" with { type: "text" };

interface ResponseItem {
	type: string;
	call_id?: string;
	name?: string;
	input?: string;
}

export interface ResponsesResult {
	output: ResponseItem[];
}

/**
 * OpenAI Responses API 的最小调用接口。
 *
 * baseUrl、apiKey、model 等细节由外部实现闭包，
 * FreeformPatchBackend 只关心 "给 input + tools，拿 result"。
 */
export interface ResponsesClient {
	create(
		input: unknown[],
		tools: unknown[],
		signal?: AbortSignal,
	): Promise<ResponsesResult | { error: string }>;
}

const MAX_ROUNDS = 25;

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

		const conversation: unknown[] = [
			{ role: "developer", content: systemPrompt },
			{
				role: "user",
				content: `<source_file>\n${source}\n</source_file>\n\n<edit_intent>\n${intent}\n</edit_intent>`,
			},
		];

		for (let round = 0; round < MAX_ROUNDS; round++) {
			if (signal?.aborted) {
				return { content: current, feedback: null, error: "Aborted", rounds: round };
			}

			callbacks?.onEvent?.(round, { type: "thinking", text: `round ${round + 1}...` });

			const tools = round === 0 ? FIRST_ROUND_TOOLS : ALL_TOOLS;
			const json = await this.client.create(conversation, tools, signal);
			if ("error" in json && typeof json.error === "string") {
				return { content: current, feedback, error: json.error, rounds: round + 1 };
			}

			let hasSubmit = false;
			if (!json || typeof json !== "object" || !("output" in json) || !Array.isArray(json.output)) {
				break;
			}
			const response = json as ResponsesResult;

			for (const item of response.output) {
				if (item.type !== "custom_tool_call") continue;
				const raw = item.input ?? "";

				switch (item.name) {
					case "apply_patch": {
						callbacks?.onToolResult?.(round, `apply_patch (${raw.split("\n").length} lines)`);

						const hunk = parsePatch(raw);
						if ("error" in hunk) {
							this.pushResult(conversation, item, `Error: ${hunk.error}`);
							break;
						}
						const result = applyPatchToSource(current, hunk);
						if (typeof result !== "string") {
							this.pushResult(conversation, item, `Error: ${result.error}`);
							break;
						}
						current = result;
						patchApplied = true;
						this.pushResult(conversation, item, "OK: Patch applied.");
						break;
					}

					case "view_file": {
						const lines = current.split("\n");
						const { start, end } = this.parseRange(raw.trim(), lines.length);
						const numbered = lines
							.slice(start - 1, end)
							.map((l, i) => `${start + i}| ${l}`)
							.join("\n");
						const content = `<source_file lines="${start}-${end}" total="${lines.length}">\n${numbered}\n</source_file>`;
						callbacks?.onToolResult?.(round, `view_file → L${start}-${end}`);
						this.pushResult(conversation, item, content);
						break;
					}

					case "submit": {
						feedback = raw.trim() || null;
						hasSubmit = true;
						callbacks?.onToolResult?.(round, feedback ? `submit\n  ${feedback}` : "submit");
						break;
					}
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

		return {
			content: current,
			feedback,
			error: patchApplied ? null : `Did not submit within ${MAX_ROUNDS} rounds`,
			rounds: MAX_ROUNDS,
		};
	}

	private pushResult(conversation: unknown[], item: ResponseItem, output: string) {
		conversation.push(item);
		conversation.push({
			type: "custom_tool_call_output",
			call_id: item.call_id,
			output,
		});
	}

	private parseRange(raw: string, totalLines: number): { start: number; end: number } {
		if (!raw) return { start: 1, end: totalLines };

		const tailMatch = raw.match(/^-(\d+)$/);
		if (tailMatch) {
			const n = Number.parseInt(tailMatch[1] as string, 10);
			return { start: Math.max(1, totalLines - n + 1), end: totalLines };
		}

		const rangeMatch = raw.match(/^(\d+)[~\-](\d+)$/);
		if (rangeMatch) {
			const s = Number.parseInt(rangeMatch[1] as string, 10);
			const e = Number.parseInt(rangeMatch[2] as string, 10);
			return { start: Math.max(1, s), end: Math.min(totalLines, e) };
		}

		return { start: 1, end: totalLines };
	}
}
