/**
 * edit tool result 格式化 — 含 anti-few-shot 变体
 */

import type { EditToolResult, PatchOp } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

// ── 变体模板 ──

const successPrefixTemplates = [
	(path: string) => `Edited \`${path}\`:`,
	(path: string) => `Modified \`${path}\`:`,
	(path: string) => `Updated \`${path}\`:`,
];

// ── patches 格式化 ──

function formatPatches(patches: PatchOp[]): string {
	if (patches.length === 0) return "(no changes)";
	return patches
		.map((p) => p.newText)
		.filter((t) => t.length > 0)
		.join("\n...\n");
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
		const summary = `${prefix(msg.call.args.path)}\n${formatPatches(msg.patches)}`;
		parts.push(tags.wrapTag("edit_result", summary));
	} else {
		parts.push(tags.wrapTag("error", `Edit failed: ${msg.error}`));
	}
	if (msg.feedback) {
		parts.push(tags.wrapTag("edit_feedback", msg.feedback));
	}
	return parts.join("\n");
}
