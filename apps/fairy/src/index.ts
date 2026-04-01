/**
 * Fairy CLI 入口 — 交互式对话循环
 *
 * MVP 实现：从状态重建上下文，执行 agentLoop，更新状态。
 * 每轮对话都是 state + stimulus → response + new-state。
 */

import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
import {
	agentLoop,
	createRuntimeContext,
	initRuntime,
	PlainRenderer,
} from "@n0n/core";
import { buildLLMConfigFromEnv, createLLMClient } from "@n0n/llm";
import { parseWorkspaceArg } from "@n0n/shared";
import type { DomainMessage } from "@n0n/types";
import { type FairyResponse, FairyResponseSchema } from "./schema.ts";
import {
	ensureFairyFiles,
	type FairyPaths,
	loadHistory,
	resolveFairyPaths,
	saveHistory,
} from "./state.ts";
import { buildView } from "./view.ts";

// ── 初始化 ──

const { workspace, remainingArgs } = parseWorkspaceArg(
	process.argv.slice(2),
	"N0N_FAIRY_WORKSPACE",
	`${process.cwd()}/.runtime/fairy`,
);

const paths = resolveFairyPaths(workspace);
ensureFairyFiles(paths);
const llmConfig = buildLLMConfigFromEnv("LLM");
const editorLlmConfig = buildLLMConfigFromEnv(
	"EDITOR_LLM",
	llmConfig.providerConfig,
);
const runtime = createRuntimeContext({
	client: createLLMClient(llmConfig),
	editorClient: createLLMClient(editorLlmConfig),
});
initRuntime(runtime);

// ── REPL ──

async function main(): Promise<void> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: isTTY,
	});

	const prompt = (query: string): Promise<string> =>
		new Promise((resolve) => rl.question(query, resolve));

	const renderer = isTTY ? new RichRenderer() : new PlainRenderer();

	let abortController = new AbortController();
	let agentRunning = false;

	// Ctrl+C 处理
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

	writeln(
		`${style.bold("fairy")} ${style.gray(`— Persistent AI Companion [${paths.workspace}]`)}`,
	);
	writeln(style.gray('与你的 fairy 对话。输入 "exit" 退出，Ctrl+C 中断输出。'));
	writeln();

	const initialInput =
		remainingArgs.length > 0 ? remainingArgs.join(" ") : undefined;

	let userInput = initialInput ?? (await prompt(`${label.user()} `));

	while (userInput.trim().toLowerCase() !== "exit") {
		// 每轮从状态重建上下文
		const history = loadHistory(paths);
		const viewMessages = buildView(history, paths, userInput);
		const viewSize = viewMessages.length;

		abortController = new AbortController();
		agentRunning = true;

		let agentResult: Awaited<ReturnType<typeof agentLoop<FairyResponse>>>;
		try {
			agentResult = await agentLoop<FairyResponse>(viewMessages, {
				maxIterations: 30,
				renderer,
				schema: FairyResponseSchema,
				signal: abortController.signal,
				toolsWorkspace: {
					workspace: paths.workspace,
					tempDir: paths.temp,
				},
			});
		} catch (err) {
			writeln();
			writeln(`${style.red("✗")} Agent 运行出错，已中止本轮。`);
			const message =
				err instanceof Error ? err.message : String(err ?? "未知错误");
			writeln(style.gray(`  ${message}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		} finally {
			agentRunning = false;
		}

		// 被用户中断
		if (abortController.signal.aborted) {
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		// 更新全局对话记录：追加本轮产生的新消息
		appendNewMessages(paths, history, agentResult.history, viewSize);

		writeln();

		if (agentResult.result == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
		} else {
			writeln(agentResult.result.reply);
		}

		writeln();
		userInput = await prompt(`${label.user()} `);
	}

	rl.close();
	writeln(style.gray("Bye!"));
}

/**
 * 追加本轮新消息到全局对话记录。
 *
 * buildView 构建了 viewSize 条消息作为上下文注入 agentLoop。
 * agentLoop 返回的 history 前 viewSize 条是注入的上下文（含 system、旧历史、stimulus），
 * 之后的是本轮 agent 新产生的消息（tool calls、results 等）。
 *
 * 我们需要保存的是：
 * - 本轮的 stimulus（user_input，即 viewMessages 的最后一条）
 * - agent 新产生的所有消息
 */
function appendNewMessages(
	paths: FairyPaths,
	oldHistory: DomainMessage[],
	agentHistory: DomainMessage[],
	viewSize: number,
): void {
	// stimulus 是 buildView 的最后一条消息（user_input）
	const stimulusIdx = viewSize - 1;
	const stimulus = agentHistory[stimulusIdx];

	// agent 新产生的消息从 viewSize 开始
	const agentNewMessages = agentHistory.slice(viewSize);

	const toAppend: DomainMessage[] = [];
	if (stimulus) toAppend.push(stimulus);
	toAppend.push(...agentNewMessages);

	const updated = [...oldHistory, ...toAppend];
	saveHistory(paths, updated);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
