/**
 * edit 工具 — 基于 Vim ex 命令的文件编辑
 *
 * 使用 neovim headless 模式执行 ex 命令序列来编辑文件。
 * 利用 LLM 对 Vim 语法的先验知识，消除 search-and-replace 模式中
 * 旧内容重复出现的偏见问题：模型只需写定址命令和新内容，不复现旧代码。
 *
 * 支持所有文件类型（代码、markdown、纯文本、配置文件等）。
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	EditToolCall,
	EditToolResult,
	LLMToolDefinition,
} from "@n0n/types";

export { EditArgsSchema } from "@n0n/types";

/** neovim 可执行文件路径，优先使用环境变量，其次尝试常见安装位置 */
function findNvim(): string {
	if (process.env.NVIM_PATH) return process.env.NVIM_PATH;

	// 尝试 PATH 中的 nvim
	try {
		const r = Bun.spawnSync(["nvim", "--version"]);
		if (r.exitCode === 0) return "nvim";
	} catch {}

	// Windows 常见安装位置
	const candidates = [
		"C:\\Program Files\\Neovim\\bin\\nvim.exe",
		`${process.env.LOCALAPPDATA}\\nvim\\bin\\nvim.exe`,
		`${process.env.PROGRAMFILES}\\Neovim\\bin\\nvim.exe`,
	];
	for (const p of candidates) {
		try {
			const r = Bun.spawnSync([p, "--version"]);
			if (r.exitCode === 0) return p;
		} catch {}
	}

	return "nvim"; // fallback, will fail with clear error
}

const NVIM_PATH = findNvim();

/** 执行超时（毫秒） */
const NVIM_TIMEOUT = 15_000;

/** 从 nvim stderr 中提取 Vim 错误（E\d{3} 格式） */
function extractVimErrors(stderr: string): string | null {
	const errorLines = stderr
		.split("\n")
		.filter((line) => /E\d{3}:/.test(line))
		.map((line) => line.trim());
	return errorLines.length > 0 ? errorLines.join("; ") : null;
}

export const EDIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "edit",
		description: [
			"Edit a file using Vim ex commands. The file must already exist.",
			"Commands are executed in neovim headless mode via a sourced script.",
			"Write commands as a multi-line string — each line is one ex command or content line.",
			"",
			"**Example 1 — Replace a function body:**",
			"```",
			"/function validateToken/+1,/^}/-1c",
			"  const decoded = jwt.verify(token);",
			"  if (!decoded) throw new Error('invalid');",
			"  return decoded.userId;",
			".",
			"```",
			"Addressing: `/pattern/+1` = line after match, `/^}/-1` = line before `}`.",
			"The `:c` (change) command replaces the addressed range with new content.",
			"A single `.` on its own line terminates the input.",
			"",
			"**Example 2 — Replace a markdown section:**",
			"```",
			"/## Installation/+1,/^##/-1c",
			"Run `npm install` to get started.",
			"",
			"See [docs](./docs) for details.",
			".",
			"```",
			"",
			"**Example 3 — Append content after a line:**",
			"```",
			"/import.*react/a",
			"import { useState } from 'react';",
			".",
			"```",
			"",
			"**Example 4 — Delete and global commands:**",
			"```",
			"g/console\\.log/d",
			"```",
			"Deletes all lines containing `console.log`.",
			"",
			"**Quick reference:**",
			"  3d                 — delete line 3",
			"  2,4d               — delete lines 2-4",
			"  %s/old/new/g       — global search & replace",
			"  /pattern/d         — delete line matching pattern",
			"  /start/,/end/d     — delete range between patterns",
			"  g/pattern/d        — delete ALL lines matching pattern",
			"",
			"**Important:**",
			"- Do NOT include `:wq` — it is added automatically.",
			"- `:c`, `:a`, `:i` commands MUST end with a single `.` on its own line.",
			"- Content lines inside `:c`/`:a`/`:i` must NOT be a lone `.` (it terminates input).",
			"  If you need a literal `.` line, use `..` or a workaround.",
			"- **Pattern addressing matches the FIRST occurrence** from current position.",
			"  When multiple similar patterns exist (e.g. multiple `}` or `function`),",
			"  include more context in your pattern to ensure unique matching.",
			"  Example: `/function validateToken/` instead of `/function /`.",
			"- **Edits are atomic**: if ANY command fails or is skipped (e.g. pattern not found),",
			"  the entire edit is rolled back. Fix all patterns and retry.",
			"- **Multiple offset-range `:c` in one call** (e.g. `/pat/+1,/pat/-1c` twice)",
			"  can cause `E493: Backwards range` because the first `:c` shifts line numbers.",
			"  Workarounds: (a) use `/start/,/end/c` without offsets and include boundary lines",
			"  in the replacement, (b) use line-number addressing from bottom to top,",
			"  or (c) split into separate edit calls.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				commands: {
					type: "string",
					description:
						"Vim ex commands as a multi-line string. Each line is one command or content line. Multi-line input commands (:c, :a, :i) are terminated by a '.' on its own line. Do NOT include :wq.",
				},
			},
			required: ["path", "commands"],
			additionalProperties: false,
		},
	},
};

/**
 * 通过 neovim headless 执行 ex 命令序列。
 *
 * 将命令写入临时 .vim 脚本文件，然后用 -c source 执行。
 * 不使用 -es stdin 管道，因为 stdin 模式对 UTF-8 多字节字符
 * （如中文）在搜索模式中存在编码问题。
 */
async function runNvimEx(
	filePath: string,
	commands: string,
): Promise<{ success: boolean; error?: string; warnings?: string }> {
	const scriptDir = mkdtempSync(join(tmpdir(), "n0n-vim-"));
	const scriptPath = join(scriptDir, "edit.vim");

	try {
		// 写入命令脚本：先禁用自动缩进，然后执行用户命令，最后 wq
		const preamble = "set noautoindent\nset nosmartindent\nset nocindent";
		const script = `${preamble}\n${commands}\nwq\n`;
		writeFileSync(scriptPath, script, "utf8");

		const sourcePath = scriptPath.replace(/\\/g, "/");
		const args = [
			"--headless",
			"-n",
			"-u",
			"NONE",
			"-c",
			`source ${sourcePath}`,
			filePath,
		];

		return await new Promise((resolve) => {
			const proc = spawn(NVIM_PATH, args, {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: NVIM_TIMEOUT,
			});

			let stderr = "";
			let errorKillTimer: ReturnType<typeof setTimeout> | null = null;

			proc.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
				// 检测到 Vim 错误码时，启动短延时强制终止
				// nvim 在某些错误（如 E493）后会挂起不退出
				if (/E\d{3}:/.test(stderr) && !errorKillTimer) {
					errorKillTimer = setTimeout(() => proc.kill(), 500);
				}
			});

			proc.on("close", (code: number | null) => {
				if (errorKillTimer) clearTimeout(errorKillTimer);
				const vimErrors = extractVimErrors(stderr);
				if (code === 0) {
					// exit=0 但 stderr 中有 Vim 错误码（如 E486: Pattern not found）
					// 表示部分命令被静默跳过
					resolve({ success: true, warnings: vimErrors ?? undefined });
				} else {
					resolve({
						success: false,
						error: vimErrors
							? `nvim error: ${vimErrors}`
							: `nvim exited with code ${code}: ${stderr.trim()}`,
					});
				}
			});

			proc.on("error", (err: Error) => {
				if (errorKillTimer) clearTimeout(errorKillTimer);
				resolve({
					success: false,
					error: `Failed to spawn nvim: ${err.message}`,
				});
			});
		});
	} finally {
		try {
			rmSync(scriptDir, { recursive: true, force: true });
		} catch {}
	}
}

export async function editTool(
	call: EditToolCall,
	workspace: string,
): Promise<EditToolResult> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { commands } = call.args;

	try {
		if (!existsSync(filePath)) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: `File not found: ${call.args.path}`,
				warnings: null,
			};
		}

		if (!commands || commands.trim().length === 0) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: "No commands provided",
				warnings: null,
			};
		}

		// 原子性编辑：备份原文件，出错或有警告时恢复
		const backup = readFileSync(filePath);
		const result = await runNvimEx(filePath, commands);

		const hasProblems = !result.success || !!result.warnings;
		if (hasProblems) {
			// 恢复原文件 — 不应用部分修改
			writeFileSync(filePath, backup);
		}

		if (!result.success) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: result.error ?? "Unknown error",
				warnings: result.warnings ?? null,
			};
		}

		if (result.warnings) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: `Rolled back — some commands were skipped: ${result.warnings}`,
				warnings: result.warnings,
			};
		}

		const cmdLines = commands.split("\n");
		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			replacedCount: cmdLines.filter((c) => /^[:/]|^\d/.test(c)).length,
			success: true,
			error: null,
			warnings: null,
		};
	} catch (err) {
		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			replacedCount: 0,
			success: false,
			error: err instanceof Error ? err.message : String(err),
			warnings: null,
		};
	}
}
