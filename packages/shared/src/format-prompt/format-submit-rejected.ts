/**
 * submit:rejected 格式化 — 含 anti-few-shot 变体
 *
 * 小参数模型容易被相同的拒绝措辞带入重复提交错误格式的循环。
 */

import type { SubmitRejectedMessage } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

const templates = [
	(attempt: number, max: number, error: string) =>
		`Submit rejected (attempt ${attempt}/${max}): ${error}`,
	(attempt: number, max: number, error: string) =>
		`Submission failed [${attempt}/${max}]: ${error}`,
	(attempt: number, max: number, error: string) =>
		`Invalid submission (try ${attempt} of ${max}) — ${error}`,
];

export function formatSubmitRejected(
	msg: SubmitRejectedMessage,
	model: string,
	msgIndex: number,
): string {
	const tpl = pick(templates, msgIndex);
	return wrapTag(
		"submit_rejected",
		tpl(msg.attempt, msg.maxAttempts, msg.error),
		model,
	);
}
