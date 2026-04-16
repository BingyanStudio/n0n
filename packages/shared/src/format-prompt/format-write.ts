/**
 * write tool result 格式化 — 含 anti-few-shot 变体
 */

import type { WriteToolResult } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

const IS_WINDOWS = process.platform === "win32";

// ── 变体模板 ──

const completedTemplates = [
	(path: string) => `Written to \`${path}\``,
	(path: string) => `File saved: \`${path}\``,
	(path: string) => `\`${path}\` created successfully`,
];

const recoveredTemplates = [
	(path: string) => [
		`Partial write to \`${path}\` (content was truncated by max_tokens).`,
		`The file contains only the first portion of your intended content.`,
		``,
		`To complete it, choose one strategy:`,
		`1. Write the remaining content to a temp file, then use exec to append it: exec({ script: "${IS_WINDOWS ? "type tmp_rest.txt >> target_file" : "cat tmp_rest.txt >> target_file"}" })`,
		`2. Break the file into smaller, well-structured modules and write each separately.`,
		`Do NOT use edit for large appends — it is intent-driven and not suited for bulk content insertion.`,
	].join("\n"),
	(path: string) => [
		`\`${path}\` was partially written — output was cut short by max_tokens.`,
		`Only the beginning of the intended content is in the file.`,
		``,
		`Recovery options:`,
		`1. Write the rest to a temp file and append: exec({ script: "${IS_WINDOWS ? `type remaining.txt >> ${path}` : `cat remaining.txt >> ${path}`}" })`,
		`2. Split into smaller modules and write each one separately.`,
		`Avoid using edit for bulk appends.`,
	].join("\n"),
	(path: string) => [
		`Truncated write to \`${path}\` — the file is incomplete (max_tokens reached).`,
		``,
		`To finish writing:`,
		`1. Put the remaining content in a temp file and concatenate via exec.`,
		`2. Or restructure into smaller files.`,
		`Do not use edit for large content insertions.`,
	].join("\n"),
];

// ── 格式化函数 ──

export function formatWriteResult(
	msg: WriteToolResult,
	model: string,
	msgIndex: number,
): string {
	switch (msg.status) {
		case "completed": {
			const tpl = pick(completedTemplates, msgIndex);
			return wrapTag("write_result", tpl(msg.call.args.path), model);
		}
		case "failed":
			return wrapTag("error", `Write failed: ${msg.error}`, model);
		case "recovered": {
			const tpl = pick(recoveredTemplates, msgIndex);
			return wrapTag("write_result", tpl(msg.call.args.path), model);
		}
		case "recover_failed":
			return wrapTag(
				"error",
				`Write failed after truncation recovery: ${msg.error}`,
				model,
			);
		default: {
			const _exhaustive: never = msg;
			return wrapTag(
				"error",
				// biome-ignore lint/suspicious/noExplicitAny: exhaustive switch default
				`Unknown write status: ${(msg as any).status}`,
				model,
			);
		}
	}
}
