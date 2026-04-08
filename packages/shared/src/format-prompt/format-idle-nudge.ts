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
		`Your previous response was plain text with no tool calls. The user CANNOT see it — only content sent via the submit tool reaches the user. You must call tools to make progress. Idle ${idle}/${max}.`,
	(idle: number, max: number) =>
		`No tool calls detected. Your last message is invisible to the user; they only receive results delivered through submit. Use tools to proceed — idle count: ${idle}/${max}.`,
	(idle: number, max: number) =>
		`Plain text responses are never shown to the user. To deliver information, call the submit tool. To make progress, use other tools. (${idle}/${max} idle rounds)`,
];

export function formatIdleNudge(
	msg: IdleNudgeMessage,
	model: string,
	msgIndex: number,
): string {
	const tpl = pick(templates, msgIndex);
	return wrapTag("system_warning", tpl(msg.idleCount, msg.maxIdleRounds), model);
}
