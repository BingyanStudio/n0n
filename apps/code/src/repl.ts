/**
 * Code REPL — 代码编写场景的交互循环
 *
 * 与 cli REPL 的区别：
 * - System prompt 为 code.md（代码 agent 而非 workflow builder）
 * - Submit schema 为 CodeResultSchema（completed/ask_user/request_assist）
 * - Context 注入项目结构和 git 状态，而非 workflow 列表
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { isTTY, label, style, writeln } from "@n0n/cli-ui";
import {
	agentLoop,
	buildToolsConfig,
	getRuntime,
	HeartbeatKeeper,
	HeartbeatState,
	PlainRenderer,
} from "@n0n/core";
import { readMultilineInput } from "@n0n/multiline-input";
import {
	type BaseWorkspacePaths,
	loadConversation,
	parseDsl,
	saveConversation,
} from "@n0n/shared";
import { makeToolkit } from "@n0n/tools";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import { CodeRenderer } from "./code-renderer.ts";
import { buildContextFewshot } from "./context-fewshot.ts";
import { playNotifySound } from "./notify-sound.ts";
import codePromptText from "./prompts/code.md" with { type: "text" };
import { type CodeResult, CodeResultSchema } from "./schema.ts";
import { formatSubmitResult } from "./submit-formatter.ts";

export interface CodeReplOptions {
	initialInput?: string;
	resumeFile?: string;
	saveEveryLoop?: boolean;
}

type CodeWorkspacePaths = BaseWorkspacePaths;

function injectUserResponse(history: DomainMessage[], response: string): void {
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (
			msg !== undefined &&
			msg.type === "tool_result" &&
			"tool" in msg &&
			msg.tool === "submit"
		) {
			// TS 无法通过 DomainMessage → type === "tool_result" → tool === "submit" 完成窄化
			(msg as SubmitToolResult).userResponse = response;
			return;
		}
	}
}

function makeUserInput(content: string): DomainMessage {
	return {
		type: "user_input",
		content,
		context: null,
		hint: null,
	};
}

// ── stdin 状态机 ──
// 避免多个组件反复争夺 stdin 控制权（add/remove listener、toggle raw mode）
// 导致的 listener 累积和状态腐蚀。一个持久 listener + phase 路由替代。

type StdinPhase = "idle" | "input" | "agent";

interface StdinController {
	phase: StdinPhase;
	dataHandler: ((data: string) => void) | null;
	abortController: AbortController;
	/** Ctrl+P 按下时调用（心跳暂停） */
	onPause: (() => void) | null;
	dispose: () => void;
}

function createStdinController(): StdinController {
	const ctrl: StdinController = {
		phase: "idle",
		dataHandler: null,
		abortController: new AbortController(),
		onPause: null,
		dispose: () => {
			process.stdin.removeListener("data", onData);
			process.stdin.setRawMode(false);
		},
	};

	function onData(data: string) {
		switch (ctrl.phase) {
			case "input":
				if (data.includes("\x10")) {
					ctrl.onPause?.();
					break;
				}
				ctrl.dataHandler?.(data);
				break;
			case "agent":
				if (data.includes("\x11")) {
					ctrl.abortController.abort();
				}
				break;
			case "idle":
				break;
			default: {
				const _exhaustive: never = ctrl.phase;
				break;
			}
		}
	}

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

	// 基础系统提示词（稳定前缀，不含 agents.md 和环境信息）
	const baseSystemPrompt = codePromptText;

	// 构建 Toolkit — 含 CodeResultSchema，供 fewshot 和 agentLoop 共用
	const runtime = getRuntime();
	const toolsConfig = buildToolsConfig(runtime, {
		workspace: paths.workspace,
		tempDir: paths.temp,
	});
	const toolkit = await makeToolkit(
		CodeResultSchema,
		toolsConfig,
		runtime.client.modelId,
	);
	const contextFewshot = await buildContextFewshot(
		toolkit,
		paths.workspace,
		paths.temp,
	);
	// submit 结果文件编号（进程级，不随 renderer 生命周期绑定）
	const submitSessionId = randomBytes(2).toString("hex");
	let submitSeq = 0;
	const renderer = isTTY ? new CodeRenderer(paths) : new PlainRenderer();

	// ── stdin 控制器（仅 TTY 模式） ──
	const stdin = isTTY ? createStdinController() : null;

	// ── 心跳保活（仅 Anthropic 等支持 prompt caching 的 provider） ──
	const client = runtime.client;
	const keeper = client.heartbeat
		? new HeartbeatKeeper({
				sendHeartbeat: async (request) => {
					const usage = (await client.heartbeat?.(request)) ?? null;
					return usage !== null;
				},
				onTick: (count, maxCount) => {
					if (isTTY) {
						writeln(style.gray(`  ⏳ 缓存保活 (${count}/${maxCount})`));
					}
				},
				onExpired: (reason) => {
					if (isTTY) {
						const msg =
							reason === "max_count"
								? "达到上限"
								: reason === "error"
									? "请求失败"
									: "缓存已过期";
						writeln(style.gray(`  ⏸ 缓存保活已停止（${msg}）`));
					}
				},
			})
		: null;
	if (stdin && keeper) {
		stdin.onPause = () => {
			if (keeper.state === HeartbeatState.TICKING) {
				keeper.stop();
				writeln(style.gray("⏸ 缓存保活已停止。下次提交消息后会自动恢复。"));
			}
		};
	}

	// ── promptUser ──
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
					if (code === 17) {
						process.stderr.write("\n");
						stdin.dataHandler = null;
						stdin.phase = "agent";
						stdin.abortController.abort();
						resolve("n");
						return;
					}
					if (code === 13) {
						process.stderr.write("\n");
						stdin.dataHandler = null;
						stdin.phase = "agent";
						resolve(line);
						return;
					}
					if (code === 127 || code === 8) {
						if (line.length > 0) {
							line = line.slice(0, -1);
							process.stderr.write("\b \b");
						}
						continue;
					}
					if (code >= 32) {
						line += data[i];
						process.stderr.write(data[i] as string);
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
						` 已从 ${resumeFile} 恢复对话（${log.history.length} 条消息）`,
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
				{ type: "system", content: baseSystemPrompt },
				{ type: "cache_breakpoint" },
				...contextFewshot,
			];
		}
	} else {
		userInput = initialInput ?? (await promptUser());
		history = [
			{ type: "system", content: baseSystemPrompt },
			{ type: "cache_breakpoint" },
			...contextFewshot,
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

		// ── `pause` 命令：停止心跳保活 ──
		if (userInput.trim().toLowerCase() === "pause") {
			if (keeper && keeper.state === HeartbeatState.TICKING) {
				keeper.stop();
				writeln(style.gray("⏸ 缓存保活已停止。下次提交消息后会自动恢复。"));
			} else {
				writeln(style.gray("当前没有活跃的缓存保活。"));
			}
			writeln();
			userInput = await promptUser();
			continue;
		}

		// ── 将用户输入推入 history ──
		// ── 停止心跳（agent 执行期间由 stream 自行刷新缓存） ──
		keeper?.stop();
		history.push(makeUserInput(userInput));

		// ── Agent 运行阶段：切换到 agent phase ──
		if (stdin) {
			stdin.abortController = new AbortController();
			stdin.phase = "agent";
		}

		let agentResult: Awaited<ReturnType<typeof agentLoop<CodeResult>>>;
		try {
			agentResult = await agentLoop<CodeResult>(history, {
				toolkit,
				schema: CodeResultSchema,
				maxIterations: 100,
				renderer,
				confirmFn,
				signal: stdin?.abortController.signal,
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
		// agent 结束，启动心跳保活（使用相同的 messages + tools 确保缓存前缀一致）
		keeper?.start({
			messages: history,
			tools: agentResult.tools,
			toolChoice: "auto",
		});

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

		// 将已验证的 submit 结果写入编号文件 + 固定文件
		submitSeq++;
		const submitFilename = `submit-${submitSessionId}-${String(submitSeq).padStart(4, "0")}.md`;
		const formatted = formatSubmitResult(ir);
		try {
			if (!existsSync(paths.temp)) mkdirSync(paths.temp, { recursive: true });
			writeFileSync(resolve(paths.temp, submitFilename), formatted, "utf-8");
			writeFileSync(
				resolve(paths.temp, "submit-result.md"),
				formatted,
				"utf-8",
			);
		} catch {}

		switch (ir.type) {
			case "ask_user": {
				writeln(`${style.yellow("?")} ${ir.question}`);
				writeln();
				const askUserItems = parseDsl(ir.options);
				for (const [i, item] of askUserItems.entries()) {
					writeln(`  ${style.cyan(`${i + 1})`)} ${item.label}`);
					if (item.detail) {
						writeln(`     ${style.gray(item.detail)}`);
					}
				}
				writeln();
				playNotifySound();
				userInput = await promptUser();
				if (userInput !== null) {
					injectUserResponse(history, userInput);
				}
				continue;
			}
			case "request_assist": {
				writeln(`${style.yellow("🔧")} 请求协助: ${ir.content}`);
				writeln();
				const checklistItems = parseDsl(ir.checklist);
				for (const [i, item] of checklistItems.entries()) {
					writeln(`  ${style.cyan(`${i + 1})`)} ${item.label}`);
					if (item.detail) {
						writeln(`     ${style.gray(item.detail)}`);
					}
				}
				writeln();
				playNotifySound();
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
				playNotifySound();
				userInput = await promptUser();
				break;
			}
			default: {
				const _exhaustive: never = ir;
				break;
			}
		}
	}

	keeper?.stop();
	stdin?.dispose();
	writeln(style.gray("Bye!"));
}
