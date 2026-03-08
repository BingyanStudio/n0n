/**
 * exec 工具 — 脚本执行
 *
 * 模型提供 script（脚本内容）和 runtime（执行运行时），
 * 工具将脚本写入临时文件后用指定运行时执行。
 * 所有平台行为一致，彻底消除 shell 引号转义问题。
 *
 * runtime 支持：
 * - shell 类：sh, bash, pwsh, cmd（脚本内容即 shell 脚本，支持管道等语法）
 * - 语言类：bun, node, python（脚本内容即对应语言代码，支持 import 等）
 * - 默认：平台 shell（Windows: cmd, 其他: sh）
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
	ExecToolResult,
	LLMToolDefinition,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import { z } from "zod";
import { getToolsConfig } from "./config.ts";

/** exec 工具参数 schema */
export const ExecArgsSchema = z.object({
	script: z.string(),
	runtime: z.string().optional(),
	cwd: z.string().optional(),
	timeout: z.number().optional(),
});

export type ExecArgs = z.infer<typeof ExecArgsSchema>;

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_RUNTIME = IS_WINDOWS ? "cmd" : "sh";

/** runtime → 临时文件扩展名 */
const RUNTIME_EXT: Record<string, string> = {
	sh: ".sh",
	bash: ".sh",
	cmd: ".cmd",
	pwsh: ".ps1",
	bun: ".ts",
	node: ".mjs",
	python: ".py",
};

/** runtime → 执行命令构造器 */
function buildSpawnCmd(runtime: string, tmpFile: string): string[] {
	switch (runtime) {
		case "cmd":
			return ["cmd", "/c", tmpFile];
		case "sh":
		case "bash":
			return [runtime, tmpFile];
		case "pwsh":
			return ["pwsh", "-NoProfile", "-File", tmpFile];
		case "bun":
			return ["bun", "run", tmpFile];
		case "node":
			return ["node", tmpFile];
		case "python":
			return ["python", tmpFile];
		default:
			// 未知 runtime 当作可执行文件名处理
			return [runtime, tmpFile];
	}
}

export const EXEC_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "exec",
		description: [
			"Execute a script. The script content is written to a temp file and run with the specified runtime.",
			`Available runtimes: sh, bash, cmd, pwsh (shell scripts with pipes/conditionals), bun, node, python (code with imports).`,
			`Default runtime: ${DEFAULT_RUNTIME}. Use "bun" for TypeScript/JS, "pwsh" for PowerShell, "sh" for Unix shell.`,
			"For simple commands (git status, bunx tsc), use the platform shell runtime.",
			"Best practice: process output INSIDE the script (grep, filter, summarize) and only print what you need — avoid dumping large raw output into context.",
			"Debugging tips: use `2>&1` to merge stderr into stdout; append `&& echo __DONE__` to confirm execution completed; use `> output.txt 2>&1` to capture output to file.",
			"Returns stdout, stderr, and exit code.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				script: {
					type: "string",
					description:
						"Script content to execute. Can be a simple command or a multi-line script with full language features.",
				},
				runtime: {
					type: "string",
					description: `Runtime to execute the script (default: "${DEFAULT_RUNTIME}"). Options: sh, bash, cmd, pwsh, bun, node, python.`,
				},
				cwd: {
					type: "string",
					description: "Working directory (default: injected workspace root)",
				},
				timeout: {
					type: "number",
					description:
						"Timeout in seconds (default: 120). Process continues in background if exceeded.",
				},
			},
			required: ["script"],
			additionalProperties: false,
		},
	},
};
/** 运行环境摘要，供 system prompt 注入 */
export function getEnvInfo(): {
	os: string;
	shell: string;
	cwd: string;
} {
	const config = getToolsConfig();
	return {
		os: IS_WINDOWS ? "Windows" : process.platform,
		shell: DEFAULT_RUNTIME,
		cwd: config.workspace,
	};
}
function extractCommandNames(script: string): string[] {
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

function findBlockedCommand(script: string): string | null {
	const blocked = getToolsConfig().security.blockedCommands;
	if (blocked.length === 0) return null;
	const blockedNormalized = IS_WINDOWS
		? blocked.map((b) => b.toLowerCase())
		: blocked;
	const names = extractCommandNames(script);
	for (const name of names) {
		const basename = name.split(/[\\/]/).at(-1) ?? name;
		const basenameNormalized = IS_WINDOWS ? basename.toLowerCase() : basename;
		if (blockedNormalized.includes(basenameNormalized)) return basename;
	}
	return null;
}

async function handleBlockedCommand(
	callId: string,
	args: ExecArgs,
	cwd: string,
	blockedCmd: string,
	confirmFn?: (question: string) => Promise<string>,
): Promise<ExecToolResult | null> {
	const runtime = args.runtime ?? DEFAULT_RUNTIME;
	if (confirmFn) {
		const safeScript = [...args.script]
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
				callId,
				tool: "exec",
				script: args.script,
				runtime,
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
		script: args.script,
		runtime,
		cwd,
		exitCode: 1,
		stdout: "",
		stderr: `Command blocked: '${blockedCmd}' is in the BLOCKED_COMMANDS list and requires manual review before execution.`,
		durationMs: 0,
	};
}
export async function* execToolStream(
	callId: string,
	args: ExecArgs,
	confirmFn?: (question: string) => Promise<string>,
	workspaceOverride?: { workspace: string; tempDir: string },
): AsyncGenerator<ToolStreamEvent> {
	const runtime = args.runtime ?? DEFAULT_RUNTIME;
	// 相对路径基于 workspace 解析，绝对路径保持不变
	const workspace = workspaceOverride?.workspace ?? getToolsConfig().workspace;
	const cwd = args.cwd
		? isAbsolute(args.cwd)
			? args.cwd
			: resolve(workspace, args.cwd)
		: workspace;
	const timeoutMs = (args.timeout ?? 120) * 1000;
	const start = Date.now();

	// Security check — scan script content for blocked commands
	const blockedCmd = findBlockedCommand(args.script);
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

	// Write script to temp file, execute with specified runtime
	const ext = RUNTIME_EXT[runtime] ?? "";
	const tempDir = resolve(
		workspaceOverride?.tempDir ?? getToolsConfig().tempDir,
	);
	if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
	const tmpFile = join(
		tempDir,
		`_n0n_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
	);

	try {
		// cmd runtime: prefix with @ to suppress echo
		const scriptContent = runtime === "cmd" ? `@${args.script}\n` : args.script;
		await Bun.write(tmpFile, scriptContent);

		const spawnCmd = buildSpawnCmd(runtime, tmpFile);
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
				await new Promise<void>((r) => {
					notify = r;
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
			script: args.script,
			runtime,
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
			script: args.script,
			runtime,
			cwd,
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		} satisfies ExecToolResult;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// ignore cleanup errors
		}
	}
}
