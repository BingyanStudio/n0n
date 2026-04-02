/**
 * Code REPL — 代码编写场景的交互循环
 *
 * Ctrl+C 行为：
 * - 用户输入时：退出 REPL（readMultilineInput 返回 null → break）
 * - 模型输出时：中断当前响应（AbortController），切换到用户输入
 * - 退出方式：输入 "exit" 或在用户输入阶段按 Ctrl+C
 *
 * stdin 管理架构：
 * REPL 是 stdin 的唯一 owner。整个生命周期只做一次 setRawMode(true)，
 * 一个持久 data listener 根据当前 phase 路由数据：
 *   input → readMultilineInput（通过 connectStdin 注入）
 *   agent → 仅检测 \x03 触发 abort
 *   idle  → 忽略
 * 这避免了反复 add/remove listener 和 toggle raw mode 导致的 stdin 状态腐蚀。
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

/** Code agent 的用户输入行为引导 */
const USER_INPUT_HINT = [
	"First, ask yourself: can I answer this by calling `exec`, `write`, or `edit`? If yes — do it, then submit as `completed`.",
	"If genuinely stuck or ambiguous, submit `ask_user` with specific options for the user.",
	"Otherwise, reason out what the engineer wrote — start by calling `reminder` with your OKR breakdown, then proceed step by step.",
].join("\n");

/** REPL 启动选项 */
export interface CodeReplOptions {
	initialInput?: string;
	resumeFile?: string;
	saveEveryLoop?: boolean;
}

type CodeWorkspacePaths = BaseWorkspacePaths;

// ── 辅助函数（无 stdin 交互） ──

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

// ── stdin 状态机 ──
// stdin 是进程级单例。整个 REPL 生命周期由此状态机统一管理，
// 避免多个组件反复争夺控制权（add/remove listener、toggle raw mode）
// 导致的 stdin 内部状态腐蚀。
//
// 状态:
//   idle  — 无数据路由（REPL 启动/退出间隙）
//   input — 数据路由到 readMultilineInput 的 handler（用户输入阶段）
//   agent — 仅检测 \x03 (Ctrl+C) 触发 abort（agent 运行阶段）

type StdinPhase = "idle" | "input" | "agent";

interface StdinController {
	/** 当前阶段 */
	phase: StdinPhase;
	/** input 阶段的数据处理器（由 readMultilineInput 通过 connectStdin 注册） */
	dataHandler: ((data: string) => void) | null;
	/** agent 阶段的 AbortController */
	abortController: AbortController;
	/** 恢复 stdin 到 REPL 启动前的状态 */
	dispose: () => void;
}

function createStdinController(): StdinController {
	const ctrl: StdinController = {
		phase: "idle",
		dataHandler: null,
		abortController: new AbortController(),
		dispose: () => {
			process.stdin.removeListener("data", onData);
			process.stdin.setRawMode(false);
		},
	};

	function onData(data: string) {
		switch (ctrl.phase) {
			case "input":
				ctrl.dataHandler?.(data);
				break;
			case "agent":
				if (data.includes("\x03")) {
					ctrl.abortController.abort();
				}
				break;
			case "idle":
				break;
		}
	}

	// stdin 生命周期：REPL 启动时进入 raw mode，退出时恢复
	// 中间不再切换 raw mode，只通过 phase 路由数据
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", onData);

	return ctrl;
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

	// ── stdin 控制器（仅 TTY 模式） ──
	const stdin = isTTY ? createStdinController() : null;

	// ── promptUser: 通过 connectStdin 将数据路由到 readMultilineInput ──
	async function promptUser(): Promise<string | null> {
		if (!stdin) {
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
			connectStdin: (handler) => {
				stdin.dataHandler = handler;
				stdin.phase = "input";
				return () => {
					stdin.dataHandler = null;
					stdin.phase = "idle";
				};
			},
		});
		return result?.text ?? null;
	}

	// ── confirmFn: 在 raw mode 下直接实现行编辑，不用 readline ──
	// 避免 readline 的 emitKeypressEvents 在 stdin 上累积永久 listener
	function confirmFn(question: string): Promise<string> {
		if (!stdin) {
			// 非 TTY: 使用 readline（不涉及 raw mode 管理）
			return new Promise<string>((resolve) => {
				const rl = createInterface({
					input: process.stdin,
					output: process.stderr,
				});
				rl.question(question, (answer) => {
					rl.close();
					resolve(answer);
				});
				rl.once("close", () => resolve("n"));
			});
		}

		return new Promise<string>((resolve) => {
			process.stderr.write(question);
			let line = "";

			stdin.dataHandler = (data: string) => {
				for (let i = 0; i < data.length; i++) {
					const code = data.charCodeAt(i);
					if (code === 3) {
						// Ctrl+C → 视为拒绝，同时触发 abort
						process.stderr.write("\n");
						stdin.dataHandler = null;
						stdin.phase = "agent";
						stdin.abortController.abort();
						resolve("n");
						return;
					}
					if (code === 13) {
						// Enter → 提交
						process.stderr.write("\n");
						stdin.dataHandler = null;
						stdin.phase = "agent";
						resolve(line);
						return;
					}
					if (code === 127 || code === 8) {
						// Backspace
						if (line.length > 0) {
							line = line.slice(0, -1);
							process.stderr.write("\b \b");
						}
						continue;
					}
					if (code >= 32) {
						// 可打印字符
						line += data[i];
						process.stderr.write(data[i]!);
					}
				}
			};
			stdin.phase = "input";
		});
	}

	// ── 初始化 history ──
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
		if (userInput === null) {
			break;
		}
		if (userInput.trim().toLowerCase() === "exit") {
			break;
		}
		if (userInput.trim() === "") {
			userInput = await promptUser();
			continue;
		}

		// ── `log` 命令 ──
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

		// ── Agent 运行阶段：切换到 agent phase ──
		if (stdin) {
			stdin.abortController = new AbortController();
			stdin.phase = "agent";
		}

		let agentResult: Awaited<ReturnType<typeof agentLoop<CodeResult>>>;
		try {
			agentResult = await agentLoop<CodeResult>(history, {
				maxIterations: 100,
				renderer,
				confirmFn,
				schema: CodeResultSchema,
				signal: stdin?.abortController.signal,
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
			if (stdin) stdin.phase = "idle";
		}
		history = agentResult.history;

		// ── --save-every-loop ──
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
		if (stdin?.abortController.signal.aborted) {
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

	stdin?.dispose();
	writeln(style.gray("Bye!"));
}
