/**
 * Code REPL — 代码编写场景的交互循环
 *
 * Ctrl+C 行为：
 * - 用户输入时：退出 REPL（readMultilineInput 返回 null → break）
 * - 模型输出时：中断当前响应（AbortController），切换到用户输入
 * - 退出方式：输入 "exit" 或在用户输入阶段按 Ctrl+C
 *
 * 与 cli REPL 的区别：
 * - System prompt 为 code.md（代码 agent 而非 workflow builder）
 * - Submit schema 为 CodeResultSchema（completed/ask_user/request_assist）
 * - Context 注入项目结构和 git 状态，而非 workflow 列表
 *
 * 对话持久化：
 * - `log` 命令：导出当前对话历史到 workspace 根目录
 * - `--resume <file>`：从文件恢复对话继续
 * - `--save-every-loop`：每轮 agentLoop 结束后自动保存到 n0n-conversation-latest.json
 */

import { createInterface } from "node:readline";
import { isTTY, label, style, writeln } from "@n0n/cli-ui";
import { agentLoop, PlainRenderer } from "@n0n/core";
import { readMultilineInput } from "@n0n/multiline-input";
import {
	type BaseWorkspacePaths,
	formatAgentsMdPrompt,
	loadAgentsMd,
	loadConversation,
	saveConversation,
} from "@n0n/shared";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import { CodeRenderer } from "./code-renderer.ts";
import codePromptText from "./prompts/code.md" with { type: "text" };
import { type CodeResult, CodeResultSchema } from "./schema.ts";

/** Code agent 的用户输入行为引导 — 无 chat 类型，专注工具调用和代码交付 */
const USER_INPUT_HINT = [
	"First, ask yourself: can I answer this by calling `exec`, `write`, or `edit`? If yes — do it, then submit as `completed`.",
	"If genuinely stuck or ambiguous, submit `ask_user` with specific options for the user.",
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
		hint: USER_INPUT_HINT,
	};
}

/**
 * 使用 @n0n/multiline-input 读取用户输入
 *
 * @returns 用户输入文本，Ctrl+C 中断时返回 null
 */
async function promptUser(): Promise<string | null> {
	if (!isTTY) {
		// 非 TTY 模式：使用 readline 逐行读取
		return new Promise<string | null>((resolve) => {
			const rl = createInterface({
				input: process.stdin,
				output: process.stderr,
			});
			rl.question("", (answer) => {
				rl.close();
				resolve(answer || null);
			});
			rl.once("close", () => resolve(null));
		});
	}

	const result = await readMultilineInput({
		prompt: `${label.user()}`,
		hint: style.gray("(Alt+Enter 提交)"),
	});
	return result?.text ?? null;
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
	const renderer = isTTY
		? new CodeRenderer(paths.workspace)
		: new PlainRenderer();

	// ── Ctrl+C 中断控制 ──
	// 输入阶段：readMultilineInput 在 raw mode 中捕获 Ctrl+C 返回 null → REPL break 退出
	// Agent 运行阶段：通过 readline SIGINT 事件触发 AbortController.abort()
	// 注意：不能用 process.on("SIGINT")，在 Bun/Windows 上不可靠；
	//       必须用 readline 的 SIGINT 事件，与旧版行为一致
	let abortController = new AbortController();

	// ── 初始化 history：恢复模式 or 全新对话 ──
	let history: DomainMessage[];
	let userInput: string | null;

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
			userInput = await promptUser();
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err ?? "未知错误");
			writeln(`${style.red("✗")} 恢复对话失败: ${message}`);
			writeln(style.gray("  将以全新对话启动。"));
			writeln();
			userInput = initialInput ?? (await promptUser());
			history = [
				{ type: "system", content: systemPrompt },
				{ type: "system", content: buildWorkspaceContext(paths.workspace) },
			];
		}
	} else {
		userInput = initialInput ?? (await promptUser());
		history = [
			{ type: "system", content: systemPrompt },
			{ type: "system", content: buildWorkspaceContext(paths.workspace) },
		];
	}

	while (true) {
		// Ctrl+C → 退出 REPL
		if (userInput === null) {
			break;
		}

		// exit 退出
		if (userInput.trim().toLowerCase() === "exit") {
			break;
		}

		// 空输入跳过
		if (userInput.trim() === "") {
			userInput = await promptUser();
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
				writeln(`${style.green("✓")} 对话已保存到 ${style.cyan(filePath)}`);
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err ?? "未知错误");
				writeln(`${style.red("✗")} 保存对话失败: ${message}`);
			}
			writeln();
			userInput = await promptUser();
			continue;
		}

		// ── 将用户输入推入 history ──
		history.push(await makeUserInput(userInput, paths.workspace));

		// Agent 运行阶段：创建临时 readline 用于 SIGINT 捕获和工具确认
		// readMultilineInput 已结束（stdin 不在 raw mode），readline 可安全使用
		abortController = new AbortController();
		const agentRl = createInterface({
			input: process.stdin,
			output: process.stderr,
			terminal: isTTY,
		});
		agentRl.on("SIGINT", () => {
			abortController.abort();
		});
		const agentConfirmFn = (question: string): Promise<string> =>
			new Promise<string>((resolve) => {
				agentRl.question(question, (answer) => {
					resolve(answer);
				});
				agentRl.once("close", () => resolve("n"));
			});

		let agentResult: Awaited<ReturnType<typeof agentLoop<CodeResult>>>;
		try {
			agentResult = await agentLoop<CodeResult>(history, {
				maxIterations: 100,
				renderer,
				confirmFn: agentConfirmFn,
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
			userInput = await promptUser();
			continue;
		} finally {
			agentRl.close();
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

		// ── 被用户中断 ──
		if (abortController.signal.aborted) {
			writeln();
			userInput = await promptUser();
			continue;
		}

		const ir = agentResult.result;
		writeln();

		if (ir == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			writeln();
			userInput = await promptUser();
			continue;
		}

		switch (ir.type) {
			case "ask_user": {
				writeln(`${style.yellow("?")} ${ir.question}`);
				for (const [i, opt] of ir.options.entries()) {
					writeln(`  ${style.cyan(`${i + 1})`)} ${opt.choice}`);
					writeln(`     ${style.gray(opt.affect)}`);
				}
				writeln();
				userInput = await promptUser();
				if (userInput !== null) {
					injectUserResponse(history, userInput);
				}
				continue;
			}
			case "request_assist": {
				writeln(`${style.yellow("🔧")} 请求协助: ${ir.content}`);
				for (const [i, item] of ir.checklist.entries()) {
					writeln(`  ${style.cyan(`${i + 1})`)} ${item.label}`);
					if (item.detail) {
						writeln(`     ${style.gray(item.detail)}`);
					}
				}
				writeln();
				userInput = await promptUser();
				if (userInput !== null) {
					injectUserResponse(history, userInput);
				}
				continue;
			}
			case "completed": {
				writeln(`${style.green("✓")} 完成: ${ir.summary}`);
				if (ir.next_step) {
					writeln(style.gray(`  后续: ${ir.next_step}`));
				}
				if (agentResult.report) {
					writeln(style.gray(`  ${agentResult.report}`));
				}
				writeln();
				userInput = await promptUser();
				break;
			}
		}
	}

	writeln(style.gray("Bye!"));
}
