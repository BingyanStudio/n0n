/**
 * progress:rejected 格式化 — 含 anti-few-shot 变体
 *
 * 小参数模型容易被相同的拒绝措辞带入重复提交错误格式的循环。
 */

import type { ProgressRejectedMessage } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const templates = [
	(attempt: number, max: number, error: string) =>
		`Progress rejected (attempt ${attempt}/${max}): ${error}`,
	(attempt: number, max: number, error: string) =>
		`Progress call failed [${attempt}/${max}]: ${error}`,
	(attempt: number, max: number, error: string) =>
		`Invalid progress (try ${attempt} of ${max}) — ${error}`,
];

export function formatProgressRejected(
	msg: ProgressRejectedMessage,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const tpl = pick(templates, msgIndex);
	return tags.wrapTag(
		"progress_rejected",
		tpl(msg.attempt, msg.maxAttempts, msg.error),
	);
}
