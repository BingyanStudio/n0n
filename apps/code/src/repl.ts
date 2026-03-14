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
 */

import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
import { agentLoop, PlainRenderer } from "@n0n/core";
import {
	type BaseWorkspacePaths,
	formatAgentsMdPrompt,
	loadAgentsMd,
} from "@n0n/shared";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import codePromptText from "./prompts/code.md" with { type: "text" };
import { type CodeResult, CodeResultSchema } from "./schema.ts";

/** Code agent 的用户输入行为引导 — 无 chat 类型，专注工具调用和代码交付 */
const USER_INPUT_HINT = [
	"First, ask yourself: can I answer this by calling `exec`, `write`, or `edit`? If yes — do it, then submit as `completed`.",
	"If genuinely stuck or ambiguous, submit `need_info` with specific options for the user.",
	"Otherwise, reason out what the engineer wrote — start by calling `reminder` with your OKR breakdown, then proceed step by step.",
].join("\n");

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
export async function startCodeRepl(
	paths: CodeWorkspacePaths,
	initialInput?: string,
): Promise<void> {
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

	const prompt = (q: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("exit");
			rl.question(q, resolve);
		});
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
				rl.close();
			}
		});
	} else {
		process.on("SIGINT", () => {
			if (agentRunning) {
				abortController.abort();
			} else {
				process.exit(0);
			}
		});
	}

	let userInput = initialInput ?? (await prompt(`${label.user()} `));
	let history: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
		{ type: "system", content: buildWorkspaceContext(paths.workspace) },
		{
			type: "user_input",
			content: userInput,
			context: await gatherContext(paths.workspace),
			capabilities: null,
			hint: USER_INPUT_HINT,
		},
	];

	while (userInput.trim().toLowerCase() !== "exit") {
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
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths.workspace),
				capabilities: null,
			hint: USER_INPUT_HINT,
			});
			continue;
		} finally {
			agentRunning = false;
		}
		history = agentResult.history;

		// ── 被用户中断（通过 AbortController.signal 判断，避免与 submit report 冲突） ──
		if (abortController.signal.aborted) {
			writeln();
			userInput = await prompt(`${label.user()} `);
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths.workspace),
				capabilities: null,
			hint: USER_INPUT_HINT,
			});
			continue;
		}

		const ir = agentResult.result;
		writeln();

		if (ir == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths.workspace),
				capabilities: null,
			hint: USER_INPUT_HINT,
			});
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
				history.push({
					type: "user_input",
					content: userInput,
					context: await gatherContext(paths.workspace),
					capabilities: null,
				hint: USER_INPUT_HINT,
				});
				break;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}
