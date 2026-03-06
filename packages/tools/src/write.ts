/**
 * write 工具 — 文件写入/编辑
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LLMToolDefinition, WriteToolResult } from "@n0n/types";
import { z } from "zod";

/** write 工具参数 schema — 运行时校验 LLM 传入的参数 */
export const WriteArgsSchema = z.object({
	path: z.string(),
	search: z.string().optional(),
	replace: z.string(),
	expectedMatches: z.number().optional(),
});

export type WriteArgs = z.infer<typeof WriteArgsSchema>;

export const WRITE_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "write",
		description:
			"Write or edit a file. If search is provided, replaces matching text. If search is empty/omitted, writes the entire file content. Use expectedReplaceTime to assert expected number of replacements.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				search: {
					type: "string",
					description:
						"Text to search for. Empty or omitted = full file write.",
				},
				replace: {
					type: "string",
					description: "Replacement text",
				},
				expectedMatches: {
					type: "number",
					description:
						"Expected number of matches (default: 1). Mismatch = error returned.",
				},
			},
			required: ["path", "replace"],
			additionalProperties: false,
		},
	},
};

export async function writeTool(
	callId: string,
	args: WriteArgs,
): Promise<WriteToolResult> {
	const filePath = resolve(args.path);
	const search = args.search ?? "";
	const expectedCount = args.expectedMatches ?? 1;

	try {
		if (!search) {
			const dir = dirname(filePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			await Bun.write(filePath, args.replace);
			return {
				type: "tool_result",
				callId,
				tool: "write",
				path: args.path,
				searchPattern: "",
				replacedCount: 0,
				success: true,
				error: null,
			};
		}

		if (!existsSync(filePath)) {
			return {
				type: "tool_result",
				callId,
				tool: "write",
				path: args.path,
				searchPattern: search,
				replacedCount: 0,
				success: false,
				error: `File not found: ${args.path}`,
			};
		}

		const content = await Bun.file(filePath).text();
		let count = 0;
		let pos = 0;
		while (true) {
			const idx = content.indexOf(search, pos);
			if (idx === -1) break;
			count++;
			pos = idx + search.length;
		}

		if (count !== expectedCount) {
			return {
				type: "tool_result",
				callId,
				tool: "write",
				path: args.path,
				searchPattern: search,
				replacedCount: count,
				success: false,
				error: `Expected ${expectedCount} match(es) but found ${count}`,
			};
		}

		const newContent = content.replaceAll(search, args.replace);
		await Bun.write(filePath, newContent);

		return {
			type: "tool_result",
			callId,
			tool: "write",
			path: args.path,
			searchPattern: search,
			replacedCount: count,
			success: true,
			error: null,
		};
	} catch (err) {
		return {
			type: "tool_result",
			callId,
			tool: "write",
			path: args.path,
			searchPattern: search,
			replacedCount: 0,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
