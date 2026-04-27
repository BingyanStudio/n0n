/**
 * edit tool result 格式化 — 含 anti-few-shot 变体
 */

import type { EditDiff, EditToolResult } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

// ── 变体模板 ──

const successPrefixTemplates = [
	(path: string) => `Edited \`${path}\`:`,
	(path: string) => `Modified \`${path}\`:`,
	(path: string) => `Updated \`${path}\`:`,
];

// ── diff 格式化 ──

function formatDiffText(diff: EditDiff): string {
	if (diff.chunks.length === 0) return "(no changes)";
	const sections: string[] = [];
	for (const chunk of diff.chunks) {
		const body = chunk.lines.map((dl) => dl.content).join("\n");
		sections.push(body);
	}
	return sections.join("\n...\n");
}

// ── 格式化函数 ──

export function formatEditResult(
	msg: EditToolResult,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const parts: string[] = [];
	if (msg.success) {
		const prefix = pick(successPrefixTemplates, msgIndex);
		const summary = `${prefix(msg.call.args.path)}\n${formatDiffText(msg.diff)}`;
		parts.push(tags.wrapTag("edit_result", summary));
	} else {
		parts.push(tags.wrapTag("error", `Edit failed: ${msg.error}`));
	}
	if (msg.feedback) {
		parts.push(tags.wrapTag("edit_feedback", msg.feedback));
	}
	return parts.join("\n");
}
