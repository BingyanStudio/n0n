/**
 * Code REPL — 代码编写场景的交互循环
 *
 * Ctrl+C 在模型输出时中断当前响应（而非立即终止进程），用户可在中断后继续输入新消息推入对话。
 * 在等待用户输入时，按下 Ctrl+C 会退出 REPL 进程。
 *
 * 与 cli REPL 的区别：
 * - System prompt 为 code.md（代码 agent 而非 workflow builder）
 * - Submit schema 为 CodeResultSchema（completed/need_info）
 * - Context 注入项目结构和 git 状态，而非 workflow 列表
 *
 * 对话持久化：
 * - `log` 命令：导出当前对话历史到 workspace 根目录
 * - `--resume <file>`：从文件恢复对话继续
 * - `--save-every-loop`：每轮 agentLoop 结束后自动保存到 n0n-conversation-latest.json
 */

import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
import { agentLoop, PlainRenderer } from "@n0n/core";
import {
	type BaseWorkspacePaths,
	formatAgentsMdPrompt,
	loadAgentsMd,
	loadConversation,
	saveConversation,
} from "@n0n/shared";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import codePromptText from "./prompts/code.md" with { type: "text" };
import { type CodeResult, CodeResultSchema } from "./schema.ts";
import { readMultilineInput } from "./multiline-input.ts";

/** Code agent 的用户输入行为引导 — 无 chat 类型，专注工具调用和代码交付 */
const USER_INPUT_HINT = [
	"First, ask yourself: can I answer this by calling `exec`, `write`, or `edit`? If yes — do it, then submit as `completed`.",
	"If genuinely stuck or ambiguous, submit `need_info` with specific options for the user.",
	"Otherwise, reason out what the engineer wrote — start by calling `reminder` with your OKR breakdown, then proceed step by step.",
].join("\n");

/** REPL 启动选项 */
export interface CodeReplOptions {
	/** 初始用户输入（来自命令行裸参数） */
	initialInput?: string;
	/** --resume 指定的对话日志文件路径 */
	resumeFile?: string;
	/** --save-every-loop 是否每轮自动保存 */
	saveEveryLoop?: boolean;
}

type CodeWorkspacePaths = BaseWorkspacePaths;

function buildWorkspaceContext(workspace: string): string {
	return [
		"## Workspace Environment",
		"",
		`Your current working directory (cwd) is: \`${workspace}\``,
		"All tool paths resolve relative to this directory:",
		"- `exec` scripts run with cwd = workspace root (the project directory)",
		"- `write` / `edit` relative paths resolve against workspace root",
		"",
		"Use relative paths (e.g. `src/utils.ts`) — they will resolve correctly.",
		"Read existing code before modifying it to understand project structure.",
	].join("\n");
}

async function gatherContext(workspace: string): Promise<string | null> {
	const parts: string[] = [];
	try {
		const gitStatus = Bun.spawnSync(["git", "status", "--short"], {
			cwd: workspace,
		});
		const status = gitStatus.stdout.toString().trim();
		if (status) {
			parts.push(`<git_status>\n${status}\n</git_status>`);
		}
		const gitBranch = Bun.spawnSync(["git", "branch", "--show-current"], {
			cwd: workspace,
		});
		const branch = gitBranch.stdout.toString().trim();
		if (branch) {
			parts.push(`<git_branch>${branch}</git_branch>`);
		}
	} catch {}
	return parts.length > 0 ? parts.join("\n") : null;
}

function injectUserResponse(history: DomainMessage[], response: string): void {
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (
			msg !== undefined &&
			msg.type === "tool_result" &&
			"tool" in msg &&
			msg.tool === "submit"
		) {
			(msg as SubmitToolResult).userResponse = response;
			return;
		}
	}
}

/** 构造 user_input 消息 */
async function makeUserInput(
	content: string,
	workspace: string,
): Promise<DomainMessage> {
	return {
		type: "user_input",
		content,
		context: await gatherContext(workspace),
		capabilities: null,
		hint: USER_INPUT_HINT,
	};
}

export async function startCodeRepl(
	paths: CodeWorkspacePaths,
	options: CodeReplOptions = {},
): Promise<void> {
	const { initialInput, resumeFile, saveEveryLoop = false } = options;

	let systemPrompt = codePromptText;
	const agentsMd = await loadAgentsMd(paths.workspace);
	if (agentsMd) {
		systemPrompt += `\n\n${formatAgentsMdPrompt(agentsMd)}`;
	}
	const renderer = isTTY ? new RichRenderer() : new PlainRenderer();

	const rl = createInterface({
		input: process.stdin,
		output: process.stderr,
		terminal: isTTY,
	});
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});

	const continuationPrompt = isTTY ? style.gray("... ") : "";
	const prompt = async (q: string): Promise<string> => {
		const result = await readMultilineInput(rl, q, { continuationPrompt });
		return result ?? "exit";
	};
	const confirmFn = (question: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("n");
			rl.question(question, resolve);
		});

	// ── Ctrl+C 中断控制 ──
	let abortController = new AbortController();
	let agentRunning = false;

	if (isTTY) {
		rl.on("SIGINT", () => {
			if (agentRunning) {
				abortController.abort();
			} else {
				writeln();
				writeln(style.gray("Bye!"));
				rl.close();
			}
		});
	} else {
		process.on("SIGINT", () => {
			if (agentRunning) {
				abortController.abort();
			} else {
				writeln();
				writeln(style.gray("Bye!"));
				process.exit(0);
			}
		});
	}

	// ── 初始化 history：恢复模式 or 全新对话 ──
	let history: DomainMessage[];
	let userInput: string;

	if (resumeFile) {
		try {
			const log = loadConversation(resumeFile);
			history = log.history;
			writeln(
				style.green("✓") +
					style.gray(
						` 已从 ${resumeFile} 恢复对话（${log.metadata.messageCount} 条消息）`,
					),
			);
			writeln();
			userInput = await prompt(`${label.user()} `);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err ?? "未知错误");
			writeln(`${style.red("✗")} 恢复对话失败: ${message}`);
			writeln(style.gray("  将以全新对话启动。"));
			writeln();
			userInput = initialInput ?? (await prompt(`${label.user()} `));
			history = [
				{ type: "system", content: systemPrompt },
				{ type: "system", content: buildWorkspaceContext(paths.workspace) },
			];
		}
	} else {
		userInput = initialInput ?? (await prompt(`${label.user()} `));
		history = [
			{ type: "system", content: systemPrompt },
			{ type: "system", content: buildWorkspaceContext(paths.workspace) },
		];
	}

	while (userInput.trim().toLowerCase() !== "exit") {
		// 空输入跳过，重新 prompt
		if (userInput.trim() === "") {
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		// ── `log` 命令：导出对话历史 ──
		if (userInput.trim().toLowerCase() === "log") {
			try {
				const filePath = saveConversation(
					history,
					paths.workspace,
					paths.workspace,
				);
				writeln(
					`${style.green("✓")} 对话已保存到 ${style.cyan(filePath)}`,
				);
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err ?? "未知错误");
				writeln(`${style.red("✗")} 保存对话失败: ${message}`);
			}
			writeln();
			userInput = await prompt(`${label.user()} `);
			// log 命令不推入 history，直接继续
			continue;
		}

		// ── 将用户输入推入 history（在 log/exit 检测之后，确保指令不污染对话历史）──
		history.push(await makeUserInput(userInput, paths.workspace));

		abortController = new AbortController();
		agentRunning = true;
		let agentResult: Awaited<ReturnType<typeof agentLoop<CodeResult>>>;
		try {
			agentResult = await agentLoop<CodeResult>(history, {
				maxIterations: 100,
				renderer,
				confirmFn,
				schema: CodeResultSchema,
				signal: abortController.signal,
				toolsWorkspace: { workspace: paths.workspace, tempDir: paths.temp },
			});
		} catch (err) {
			writeln();
			writeln(`${style.red("✗")} Agent 运行出错，已中止本轮对话。`);
			const message =
				err instanceof Error ? err.message : String(err ?? "未知错误");
			writeln(style.gray(`  ${message}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		} finally {
			agentRunning = false;
		}
		history = agentResult.history;

		// ── --save-every-loop：每轮自动保存 ──
		if (saveEveryLoop) {
			try {
				saveConversation(
					history,
					paths.workspace,
					paths.workspace,
					"n0n-conversation-latest.json",
				);
			} catch {
				// 自动保存失败不阻断 REPL
			}
		}

		// ── 被用户中断（通过 AbortController.signal 判断，避免与 submit report 冲突） ──
		if (abortController.signal.aborted) {
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		const ir = agentResult.result;
		writeln();

		if (ir == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		switch (ir.type) {
			case "need_info": {
				writeln(`${style.yellow("?")} ${ir.question}`);
				for (const [i, opt] of ir.options.entries()) {
					writeln(`  ${style.cyan(`${i + 1})`)} ${opt.choice}`);
					writeln(`     ${style.gray(opt.affect)}`);
				}
				writeln();
				userInput = await prompt(`${label.user()} `);
				injectUserResponse(history, userInput);
				continue;
			}
			case "completed": {
				writeln(`${style.green("✓")} 完成: ${ir.summary}`);
				if (ir.files_changed.length > 0) {
					writeln(style.gray(`  变更文件: ${ir.files_changed.join(", ")}`));
				}
				if (agentResult.report) {
					writeln(style.gray(`  ${agentResult.report}`));
				}
				writeln();
				userInput = await prompt(`${label.user()} `);
				break;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}
