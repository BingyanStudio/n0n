/**
 * exec 权限控制 — 命令黑名单检测与用户确认
 *
 * 扫描脚本内容中的命令名，与 blockedCommands 列表比对。
 * 命中时可通过 confirmFn 请求用户确认，或直接拒绝执行。
 */

import type { ExecToolCall, ExecToolResult } from "@n0n/types";

const IS_WINDOWS = process.platform === "win32";

/** 从脚本内容中提取命令名列表 */
export function extractCommandNames(script: string): string[] {
	const parts = script.split(/\r?\n|&&|\|\||;|\||&/);
	return parts
		.map((part) => {
			const tokens = part.trim().split(/\s+/);
			const firstNonAssign = tokens.find(
				(t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t),
			);
			return firstNonAssign ?? "";
		})
		.filter((name) => name.length > 0);
}

/** 检查脚本中是否包含被封禁的命令，返回首个命中的命令名或 null */
export function findBlockedCommand(
	script: string,
	blockedCommands: string[],
): string | null {
	if (blockedCommands.length === 0) return null;
	const blockedNormalized = IS_WINDOWS
		? blockedCommands.map((b) => b.toLowerCase())
		: blockedCommands;
	const names = extractCommandNames(script);
	for (const name of names) {
		const basename = name.split(/[\\/]/).at(-1) ?? name;
		const basenameNormalized = IS_WINDOWS ? basename.toLowerCase() : basename;
		if (blockedNormalized.includes(basenameNormalized)) return basename;
	}
	return null;
}

/** 处理被封禁的命令：请求用户确认或直接拒绝 */
export async function handleBlockedCommand(
	call: ExecToolCall,
	_cwd: string,
	blockedCmd: string,
	confirmFn?: (question: string) => Promise<string>,
): Promise<ExecToolResult | null> {
	const runtime = call.args.runtime ?? (IS_WINDOWS ? "cmd" : "sh");
	if (confirmFn) {
		const safeScript = [...call.args.script]
			.map((ch) => {
				const code = ch.charCodeAt(0);
				if (code > 31 && code !== 127) return ch;
				if (ch === "\n") return "↵";
				if (ch === "\t") return "→";
				return `[^${String.fromCharCode(code + 64)}]`;
			})
			.join("");
		const answer = await confirmFn(
			`\n⚠  Script requires review: '${blockedCmd}' is in BLOCKED_COMMANDS\n` +
				`   Runtime: ${runtime}\n` +
				`   Script: ${safeScript}\n` +
				`   Allow execution? [y/N] `,
		);
		const normalized = answer.trim().toLowerCase();
		if (normalized !== "y" && normalized !== "yes") {
			return {
				type: "tool_result",
				tool: "exec" as const,
				call,
				timedOut: false,
				exitCode: 1,
				stdout: "",
				stderr: `Command '${blockedCmd}' was rejected by the user.`,
				durationMs: 0,
			} satisfies ExecToolResult;
		}
		return null;
	}
	return {
		type: "tool_result",
		tool: "exec" as const,
		call,
		timedOut: false,
		exitCode: 1,
		stdout: "",
		stderr: `Command blocked: '${blockedCmd}' is in the BLOCKED_COMMANDS list and requires manual review before execution.`,
		durationMs: 0,
	} satisfies ExecToolResult;
}
