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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

export const EDIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "edit",
		description: [
			"Edit a file using Vim ex commands. The file must already exist.",
			"Commands are executed in neovim headless mode (ex mode via stdin).",
			"",
			"Common patterns:",
			"  :3d                          — delete line 3",
			"  :2,4d                        — delete lines 2-4",
			"  :%s/old/new/g                — global search & replace",
			"  :/pattern/d                  — delete line matching pattern",
			"  :/start/,/end/d              — delete range between patterns",
			"  :/func name/+1,/^}/-1c       — change (replace) function body:",
			"    new line 1                    (followed by new content lines)",
			"    new line 2",
			"    .                             (dot on its own line ends input)",
			"  :2a                           — append after line 2:",
			"    new content",
			"    .                             (dot ends input)",
			"  :g/TODO/d                    — delete all lines matching pattern",
			"",
			"Do NOT include :wq — it is added automatically.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				commands: {
					type: "array",
					items: { type: "string" },
					description:
						"Array of Vim ex command lines. Multi-line commands (like :c, :a, :i) span multiple array elements, terminated by a single '.' element.",
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
	commands: string[],
): Promise<{ success: boolean; error?: string }> {
	const scriptDir = mkdtempSync(join(tmpdir(), "n0n-vim-"));
	const scriptPath = join(scriptDir, "edit.vim");

	try {
		// 写入命令脚本：先禁用自动缩进，然后执行用户命令，最后 wq
		const preamble = ["set noautoindent", "set nosmartindent", "set nocindent"];
		const script = `${[...preamble, ...commands, "wq"].join("\n")}\n`;
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
				stdio: ["pipe", "pipe", "pipe"],
				timeout: NVIM_TIMEOUT,
			});

			let stderr = "";
			proc.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});

			proc.on("close", (code: number | null) => {
				if (code === 0) {
					resolve({ success: true });
				} else {
					resolve({
						success: false,
						error: `nvim exited with code ${code}: ${stderr.trim()}`,
					});
				}
			});

			proc.on("error", (err: Error) => {
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
			};
		}

		if (!commands || commands.length === 0) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: "No commands provided",
			};
		}

		const result = await runNvimEx(filePath, commands);

		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			replacedCount: result.success
				? commands.filter((c) => /^[:/]|^\d/.test(c)).length
				: 0,
			success: result.success,
			error: result.success ? null : (result.error ?? "Unknown error"),
		};
	} catch (err) {
		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			replacedCount: 0,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
