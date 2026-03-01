/**
 * exec 工具 — 执行 shell 命令
 */

import { config } from "../config.ts";
import type { ExecToolResult } from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";

interface ExecArgs {
	command: string;
	cwd?: string;
	timeout?: number;
}

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

/**
 * Extract the command names from a shell command string.
 * Splits on common shell operators (;, |, &&, ||, &) and returns
 * the first token of each resulting sub-command.
 */
function extractCommandNames(command: string): string[] {
	// Split on shell operators; match multi-char operators before single-char ones
	const parts = command.split(/\r?\n|&&|\|\||;|\||&/);
	return parts
		.map((part) => {
			// Strip leading env-var assignments like FOO=bar cmd …
			const tokens = part.trim().split(/\s+/);
			const firstNonAssign = tokens.find(
				(t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t),
			);
			return firstNonAssign ?? "";
		})
		.filter((name) => name.length > 0);
}

/**
 * Returns the blocked command name if the command string contains a blocked
 * command, otherwise returns null.
 */
function findBlockedCommand(command: string): string | null {
	const blocked = config.security.blockedCommands;
	if (blocked.length === 0) return null;
	const blockedNormalized = IS_WINDOWS
		? blocked.map((b) => b.toLowerCase())
		: blocked;
	const names = extractCommandNames(command);
	for (const name of names) {
		// Match by basename so "/bin/rm" or "C:\Windows\System32\rm.exe" is still
		// blocked when "rm" is listed
		const basename = name.split(/[\\/]/).at(-1) ?? name;
		const basenameNormalized = IS_WINDOWS
			? basename.toLowerCase()
			: basename;
		if (blockedNormalized.includes(basenameNormalized)) return basename;
	}
	return null;
}

export async function execTool(
	callId: string,
	args: ExecArgs,
	confirmFn?: (question: string) => Promise<string>,
): Promise<ExecToolResult> {
	const cwd = args.cwd ?? PROJECT_ROOT;
	const timeoutMs = (args.timeout ?? 120) * 1000;
	const start = Date.now();

	// Check for blocked commands before executing
	const blockedCmd = findBlockedCommand(args.command);
	if (blockedCmd !== null) {
		if (confirmFn) {
			// Strip control characters from the command before displaying in prompt
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
			// User approved — fall through to execution
		} else {
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
	}

	try {
		const proc = Bun.spawn([...SHELL_CMD, args.command], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		// 超时处理
		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const exitCode = await proc.exited;
		clearTimeout(timer);

		const durationMs = Date.now() - start;

		// 截断过长输出
		const maxLen = 30_000;
		const truncate = (s: string) =>
			s.length > maxLen
				? `${s.slice(0, maxLen)}\n... [truncated, ${s.length} chars total]`
				: s;

		// 当 exit=0 但无任何输出时，追加诊断提示
		const hasOutput = stdout.trim() || stderr.trim();
		const hint =
			!hasOutput && exitCode === 0
				? "(no output — script may not have top-level executable code, or async operations may not have been awaited. Workflows should be run with: bun run src/main.ts run <workflow.ts>)"
				: "";

		return {
			type: "tool_result",
			callId,
			tool: "exec",
			command: args.command,
			cwd,
			exitCode,
			stdout: hint || truncate(stdout),
			stderr: truncate(stderr),
			durationMs,
		};
	} catch (err) {
		return {
			type: "tool_result",
			callId,
			tool: "exec",
			command: args.command,
			cwd,
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		};
	}
}
