/**
 * exec 工具 — 执行 shell 命令
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExecToolResult,
	LLMToolDefinition,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import { z } from "zod";
import { getToolsConfig } from "./config.ts";

/** exec 工具参数 schema — 运行时校验 LLM 传入的参数 */
export const ExecArgsSchema = z.object({
	command: z.string(),
	cwd: z.string().optional(),
	timeout: z.number().optional(),
});

export type ExecArgs = z.infer<typeof ExecArgsSchema>;

const PROJECT_ROOT = process.cwd();
const IS_WINDOWS = process.platform === "win32";
const SHELL_CMD: [string, string] = IS_WINDOWS ? ["cmd", "/c"] : ["sh", "-c"];

export const EXEC_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "exec",
		description: IS_WINDOWS
			? [
					"Execute a command via cmd.exe on Windows. Returns stdout, stderr, and exit code.",
					"Use Windows commands: `type` (not cat), `dir` (not ls), `findstr` (not grep). No `head`, `tail`, `wc`.",
					'Use `bun -e "..."` (double quotes only, no single quotes) for cross-platform JS one-liners.',
					"Known issues: `curl` may fail if a proxy is required — if curl returns exit code 6 or hangs, switch to `bun -e` with fetch().",
					"Debugging tips: use `2>&1` to merge stderr into stdout; append `&& echo __DONE__` to confirm execution completed; use `> output.txt 2>&1` to capture output to file.",
					"If a command fails 2-3 times, stop retrying and report the issue via submit.",
				].join("\n")
			: "Execute a shell command. Use for running code, reading files (cat/grep/head), system operations. Returns stdout, stderr, and exit code.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute",
				},
				cwd: {
					type: "string",
					description: "Working directory (default: project root)",
				},
				timeout: {
					type: "number",
					description:
						"Timeout in seconds (default: 120). Process continues in background if exceeded.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
};

/** 运行环境摘要，供 system prompt 注入 */
export const ENV_INFO = {
	os: IS_WINDOWS ? "Windows" : process.platform,
	shell: IS_WINDOWS ? "cmd.exe" : "sh",
	cwd: PROJECT_ROOT,
} as const;

function extractCommandNames(command: string): string[] {
	const parts = command.split(/\r?\n|&&|\|\||;|\||&/);
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

function findBlockedCommand(command: string): string | null {
	const blocked = getToolsConfig().security.blockedCommands;
	if (blocked.length === 0) return null;
	const blockedNormalized = IS_WINDOWS
		? blocked.map((b) => b.toLowerCase())
		: blocked;
	const names = extractCommandNames(command);
	for (const name of names) {
		const basename = name.split(/[\\/]/).at(-1) ?? name;
		const basenameNormalized = IS_WINDOWS ? basename.toLowerCase() : basename;
		if (blockedNormalized.includes(basenameNormalized)) return basename;
	}
	return null;
}

export async function* execToolStream(
	callId: string,
	args: ExecArgs,
	confirmFn?: (question: string) => Promise<string>,
): AsyncGenerator<ToolStreamEvent> {
	const cwd = args.cwd ?? PROJECT_ROOT;
	const timeoutMs = (args.timeout ?? 120) * 1000;
	const start = Date.now();

	const blockedCmd = findBlockedCommand(args.command);
	if (blockedCmd !== null) {
		const blocked = await handleBlockedCommand(
			callId,
			args,
			cwd,
			blockedCmd,
			confirmFn,
		);
		if (blocked) {
			yield blocked;
			return;
		}
	}

	// Windows: write command to temp .cmd file to avoid cmd.exe quote-stripping.
	// cmd /c "bun -e \"...\"" fails because cmd.exe consumes the inner quotes.
	// A .cmd file preserves all quoting exactly as written.
	let tmpFile: string | null = null;

	try {
		let spawnCmd: string[];
		if (IS_WINDOWS) {
			tmpFile = join(
				tmpdir(),
				`_n0n_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.cmd`,
			);
			await Bun.write(tmpFile, `@${args.command}\n`);
			spawnCmd = ["cmd", "/c", tmpFile];
		} else {
			spawnCmd = [...SHELL_CMD, args.command];
		}

		const proc = Bun.spawn(spawnCmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const decoder = new TextDecoder();

		const pending: ToolOutputChunk[] = [];
		let streamsDone = 0;
		let notify: (() => void) | null = null;

		const pumpStream = async (
			stream: ReadableStream<Uint8Array>,
			bucket: string[],
		) => {
			const reader = stream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					bucket.push(text);
					pending.push({
						type: "tool_output_chunk",
						callId,
						tool: "exec",
						chunk: text,
					});
					notify?.();
				}
			} finally {
				reader.releaseLock();
				streamsDone++;
				notify?.();
			}
		};

		if (!proc.stdout || !proc.stderr) {
			throw new Error("Failed to capture process streams (stdout/stderr)");
		}
		pumpStream(proc.stdout, stdoutChunks);
		pumpStream(proc.stderr, stderrChunks);

		while (streamsDone < 2 || pending.length > 0) {
			if (pending.length === 0) {
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
				notify = null;
			}
			while (pending.length > 0) {
				const chunk = pending.shift();
				if (chunk) yield chunk;
			}
		}

		const exitCode = await proc.exited;
		clearTimeout(timer);

		const durationMs = Date.now() - start;
		const stdout = stdoutChunks.join("");
		const stderr = stderrChunks.join("");

		const maxLen = 30_000;
		const truncate = (s: string) =>
			s.length > maxLen
				? `${s.slice(0, maxLen)}\n... [truncated, ${s.length} chars total]`
				: s;

		const hasOutput = stdout.trim() || stderr.trim();
		const hint =
			!hasOutput && exitCode === 0
				? "(no output — script may not have top-level executable code, or async operations may not have been awaited.)"
				: "";

		yield {
			type: "tool_result",
			callId,
			tool: "exec",
			command: args.command,
			cwd,
			exitCode,
			stdout: hint || truncate(stdout),
			stderr: truncate(stderr),
			durationMs,
		} satisfies ExecToolResult;
	} catch (err) {
		yield {
			type: "tool_result",
			callId,
			tool: "exec",
			command: args.command,
			cwd,
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		} satisfies ExecToolResult;
	} finally {
		if (tmpFile) {
			try {
				unlinkSync(tmpFile);
			} catch {
				// ignore cleanup errors
			}
		}
	}
}

async function handleBlockedCommand(
	callId: string,
	args: ExecArgs,
	cwd: string,
	blockedCmd: string,
	confirmFn?: (question: string) => Promise<string>,
): Promise<ExecToolResult | null> {
	if (confirmFn) {
		const safeCommand = [...args.command]
			.map((ch) => {
				const code = ch.charCodeAt(0);
				if (code > 31 && code !== 127) return ch;
				if (ch === "\n") return "↵";
				if (ch === "\t") return "→";
				return `[^${String.fromCharCode(code + 64)}]`;
			})
			.join("");
		const answer = await confirmFn(
			`\n⚠  Command requires review: '${blockedCmd}' is in BLOCKED_COMMANDS\n` +
				`   Command: ${safeCommand}\n` +
				`   Allow execution? [y/N] `,
		);
		const normalized = answer.trim().toLowerCase();
		if (normalized !== "y" && normalized !== "yes") {
			return {
				type: "tool_result",
				callId,
				tool: "exec",
				command: args.command,
				cwd,
				exitCode: 1,
				stdout: "",
				stderr: `Command '${blockedCmd}' was rejected by the user.`,
				durationMs: 0,
			};
		}
		return null;
	}
	return {
		type: "tool_result",
		callId,
		tool: "exec",
		command: args.command,
		cwd,
		exitCode: 1,
		stdout: "",
		stderr: `Command blocked: '${blockedCmd}' is in the BLOCKED_COMMANDS list and requires manual review before execution.`,
		durationMs: 0,
	};
}
