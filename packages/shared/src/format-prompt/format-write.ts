/**
 * write tool result 格式化 — 含 anti-few-shot 变体
 *
 * 返回 FormattedToolResult：fact（客观数据）与 hint（系统操作建议）分离。
 */

import type { WriteToolResult } from "@n0n/types";
import type { FormattedToolResult, TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const IS_WINDOWS = process.platform === "win32";

// ── 变体模板 ──

const completedTemplates = [
	(path: string) => `Written to \`${path}\``,
	(path: string) => `File saved: \`${path}\``,
	(path: string) => `\`${path}\` created successfully`,
];

const recoveredFactTemplates = [
	(path: string) =>
		`Partial write to \`${path}\` (content was truncated by max_tokens). The file contains only the first portion of your intended content.`,
	(path: string) =>
		`\`${path}\` was partially written — output was cut short by max_tokens. Only the beginning of the intended content is in the file.`,
	(path: string) =>
		`Truncated write to \`${path}\` — the file is incomplete (max_tokens reached).`,
];

const recoveredHintTemplates = [
	(path: string) =>
		`To complete it, choose one strategy:\n1. Write the remaining content to a temp file, then use exec to append it: exec({ script: "${IS_WINDOWS ? "type tmp_rest.txt >> target_file" : "cat tmp_rest.txt >> target_file"}" })\n2. Break the file into smaller, well-structured modules and write each separately.\nDo NOT use edit for large appends — it is intent-driven and not suited for bulk content insertion.`,
	(path: string) =>
		`Recovery options:\n1. Write the rest to a temp file and append: exec({ script: "${IS_WINDOWS ? `type remaining.txt >> ${path}` : `cat remaining.txt >> ${path}`}" })\n2. Split into smaller modules and write each one separately.\nAvoid using edit for bulk appends.`,
	(path: string) =>
		`To finish writing:\n1. Put the remaining content in a temp file and concatenate via exec.\n2. Or restructure into smaller files.\nDo not use edit for large content insertions.`,
];

// ── 格式化函数 ──

export function formatWriteResult(
	msg: WriteToolResult,
	tags: TagAdapter,
	msgIndex: number,
): FormattedToolResult {
	switch (msg.status) {
		case "completed": {
			const tpl = pick(completedTemplates, msgIndex);
			return {
				fact: tags.wrapTag("write_result", tpl(msg.call.args.path)),
				hint: null,
			};
		}
		case "failed":
			return {
				fact: tags.wrapTag("error", `Write failed: ${msg.error}`),
				hint: null,
			};
		case "recovered": {
			const factTpl = pick(recoveredFactTemplates, msgIndex);
			const hintTpl = pick(recoveredHintTemplates, msgIndex);
			return {
				fact: tags.wrapTag("write_result", factTpl(msg.call.args.path)),
				hint: hintTpl(msg.call.args.path),
			};
		}
		case "recover_failed":
			return {
				fact: tags.wrapTag(
					"error",
					`Write failed after truncation recovery: ${msg.error}`,
				),
				hint: null,
			};
		default: {
			const _exhaustive: never = msg;
			return {
				fact: tags.wrapTag(
					"error",
					// biome-ignore lint/suspicious/noExplicitAny: exhaustive switch default
					`Unknown write status: ${(msg as any).status}`,
				),
				hint: null,
			};
		}
	}
}
