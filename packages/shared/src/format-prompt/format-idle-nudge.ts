/**
 * idle_nudge 格式化 — 含 anti-few-shot 变体
 *
 * 连续的相同空转警告反而会强化"不用工具"的模式，
 * 变体措辞打破这种 few-shot 陷阱。
 */

import type { IdleNudgeMessage } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

const templates = [
	(idle: number, max: number) =>
		`Your previous response used no tools — the user cannot see it. If the task is not yet complete, use tools (exec, write, edit, etc.) to continue working. If it is complete, call submit to deliver your results. Idle ${idle}/${max}.`,
	(idle: number, max: number) =>
		`No tool calls detected in your last response, which is invisible to the user. Either continue working with tools, or if finished, call submit to present your results. Idle count: ${idle}/${max}.`,
	(idle: number, max: number) =>
		`Plain text replies are not delivered to the user. If work remains, call tools to make progress. If you are done, call submit — that is the only way to communicate results. (${idle}/${max} idle rounds)`,
];

export function formatIdleNudge(
	msg: IdleNudgeMessage,
	model: string,
	msgIndex: number,
): string {
	const tpl = pick(templates, msgIndex);
	return wrapTag("system_warning", tpl(msg.idleCount, msg.maxIdleRounds), model);
}
