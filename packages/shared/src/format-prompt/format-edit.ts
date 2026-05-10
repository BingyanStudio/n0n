/**
 * edit tool result 格式化 — 含 anti-few-shot 变体
 *
 * 返回 FormattedToolResult：fact（客观数据）与 hint（Editor LLM 反馈）分离。
 */

import type { EditToolResult, PatchOp } from "@n0n/types";
import type { FormattedToolResult, TagAdapter } from "./utils.ts";
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
	const parts = patches
		.map((p) => p.newText)
		.filter((t) => t.length > 0);
	return parts.length === 0 ? "(no changes)" : parts.join("\n...\n");
}

// ── 格式化函数 ──

export function formatEditResult(
	msg: EditToolResult,
	tags: TagAdapter,
	msgIndex: number,
): FormattedToolResult {
	if (msg.success) {
		const prefix = pick(successPrefixTemplates, msgIndex);
		const summary = `${prefix(msg.call.args.path)}\n${formatPatches(msg.patches)}`;
		return {
			fact: tags.wrapTag("edit_result", summary),
			hint: msg.feedback ?? null,
		};
	}
	return {
		fact: tags.wrapTag("error", `Edit failed: ${msg.error}`),
		hint: null,
	};
}
