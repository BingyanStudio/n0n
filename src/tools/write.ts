/**
 * write 工具 — 文件写入/编辑
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WriteToolResult } from "../types/domain.ts";

interface WriteArgs {
	path: string;
	search?: string;
	replace: string;
	expectedMatches?: number;
}

export async function writeTool(
	callId: string,
	args: WriteArgs,
): Promise<WriteToolResult> {
	const filePath = resolve(args.path);
	const search = args.search ?? "";
	const expectedCount = args.expectedMatches ?? 1;

	try {
		if (!search) {
			// 完整写入模式
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

		// 搜索替换模式
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
