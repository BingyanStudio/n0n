/**
 * 测试脚本：复现 RichRenderer 在流式 tool call 渲染时的问题
 *
 * 模拟 agentLoop 产生的事件序列，观察 RichRenderer 的输出行为。
 * 场景覆盖：
 *   1. 纯 tool call（无 content）：model 直接输出 tool_call_delta，无 content token
 *   2. content + tool call：先输出文字再输出工具调用
 *   3. 多个并发 tool call：同时流式输出多个工具调用参数
 *   4. tool call 参数逐字到达：JSON 从不完整到完整的解析过程
 */

import { RichRenderer } from "../rich-renderer.ts";
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";

// 捕获所有 stderr 输出用于断言
let output: string;
const originalWrite = process.stderr.write;

function captureStart() {
	output = "";
	// @ts-ignore
	process.stderr.write = function (chunk: string | Uint8Array) {
		if (typeof chunk === "string") {
			output += chunk;
		} else {
			output += new TextDecoder().decode(chunk);
		}
		return true;
	};
}

function captureStop(): string {
	process.stderr.write = originalWrite;
	return output;
}

// 辅助函数：去除 ANSI 转义序列
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
const ANSI_RE2 = /\x1b\[\?[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "").replace(ANSI_RE2, "");
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

describe("RichRenderer tool call streaming", () => {
	let renderer: RichRenderer;

	beforeEach(() => {
		renderer = new RichRenderer();
	});

	test("场景1: 纯 tool call（无 content token）— contentEnd 应正确处理 streamRegion", () => {
		captureStart();

		// 模拟 agentLoop 事件序列：roundStart → tool_call_delta × N → contentEnd → toolCallStart → toolCallEnd
		renderer.roundStart(1, 10, 3);

		// 模型直接输出 tool_call_delta，没有 content token
		renderer.toolCallArgChunk(0, "exec", '{"sc');
		renderer.toolCallArgChunk(0, undefined, 'ript":');
		renderer.toolCallArgChunk(0, undefined, '"ls -la"');
		renderer.toolCallArgChunk(0, undefined, ',"runtime":');
		renderer.toolCallArgChunk(0, undefined, '"sh"}');

		// 流结束
		renderer.contentEnd();

		// agentLoop 解析完成后调用 toolCallStart
		renderer.toolCallStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls -la", runtime: "sh" },
		});

		// 工具执行完成
		renderer.toolCallEnd({
			type: "tool_result",
			tool: "exec",
			call: { id: "call_1", tool: "exec", args: { script: "ls -la", runtime: "sh" } },
			exitCode: 0,
			stdout: "total 0\ndrwxr-xr-x  2 user staff  64 Jan  1 00:00 .",
			stderr: "",
			durationMs: 150,
		});

		const result = captureStop();
		const clean = stripAnsi(result);

		console.log("=== 场景1 输出 ===");
		console.log(clean);
		console.log("=== END ===");

		// 验证：不应出现重复的工具参数渲染
		const execMatches = clean.match(/▸.*exec/g);
		console.log("exec 渲染次数:", execMatches?.length ?? 0);
		// contentEnd 阶段渲染一次结构化参数，toolCallStart 应该被跳过
		// 最终只应看到一次结构化参数 + 一次结果摘要
	});

	test("场景2: content token + tool call — 换行分隔是否正确", () => {
		captureStart();

		renderer.roundStart(1, 10, 3);

		// 先输出一些 content
		renderer.contentToken("我来执行");
		renderer.contentToken("一下命令");

		// 然后输出 tool call
		renderer.toolCallArgChunk(0, "exec", '{"script":"echo hello"}');

		// 流结束
		renderer.contentEnd();

		renderer.toolCallStart({
			id: "call_1",
			tool: "exec",
			args: { script: "echo hello" },
		});

		renderer.toolCallEnd({
			type: "tool_result",
			tool: "exec",
			call: { id: "call_1", tool: "exec", args: { script: "echo hello" } },
			exitCode: 0,
			stdout: "hello",
			stderr: "",
			durationMs: 50,
		});

		const result = captureStop();
		const clean = stripAnsi(result);

		console.log("=== 场景2 输出 ===");
		console.log(clean);
		console.log("=== END ===");

		// 验证：content 和 tool call 之间应该有换行分隔
		// "一下命令" 后面应该有换行，然后才是工具参数
	});

	test("场景3: 多个并发 tool call — 所有工具参数都应该渲染", () => {
		captureStart();

		renderer.roundStart(1, 10, 3);

		// 两个工具调用交替流式输出
		renderer.toolCallArgChunk(0, "exec", '{"script":"ls"}');
		renderer.toolCallArgChunk(1, "write", '{"path":"test.txt"');
		renderer.toolCallArgChunk(1, undefined, ',"content":"hello"}');

		// 流结束
		renderer.contentEnd();

		// 两个 toolCallStart
		renderer.toolCallStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls" },
		});

		renderer.toolCallStart({
			id: "call_2",
			tool: "write",
			args: { path: "test.txt", content: "hello" },
		});

		// 两个 toolCallEnd
		renderer.toolCallEnd({
			type: "tool_result",
			tool: "exec",
			call: { id: "call_1", tool: "exec", args: { script: "ls" } },
			exitCode: 0,
			stdout: "file1.txt",
			stderr: "",
			durationMs: 50,
		});

		renderer.toolCallEnd({
			type: "tool_result",
			tool: "write",
			call: { id: "call_2", tool: "write", args: { path: "test.txt", content: "hello" } },
			success: true,
			error: null,
		});

		const result = captureStop();
		const clean = stripAnsi(result);

		console.log("=== 场景3 输出 ===");
		console.log(clean);
		console.log("=== END ===");

		// 验证：两个 toolCallStart 都应该被跳过（skipToolCallStarts=2）
		const execMatches = clean.match(/▸.*exec/g);
		const writeMatches = clean.match(/▸.*write/g);
		console.log("exec 渲染次数:", execMatches?.length ?? 0);
		console.log("write 渲染次数:", writeMatches?.length ?? 0);
	});

	test("场景4: tool call 参数不完整时的渐进式渲染", () => {
		captureStart();

		renderer.roundStart(1, 10, 3);

		// 逐字到达，JSON 逐步从不完整到完整
		renderer.toolCallArgChunk(0, "exec", "{");
		renderer.toolCallArgChunk(0, undefined, '"');
		renderer.toolCallArgChunk(0, undefined, "scr");
		renderer.toolCallArgChunk(0, undefined, 'ipt');
		renderer.toolCallArgChunk(0, undefined, '":');
		renderer.toolCallArgChunk(0, undefined, '"echo ');
		renderer.toolCallArgChunk(0, undefined, 'hello"');
		renderer.toolCallArgChunk(0, undefined, '}');

		renderer.contentEnd();

		const result = captureStop();
		const clean = stripAnsi(result);

		console.log("=== 场景4 输出 ===");
		console.log(clean);
		console.log("=== END ===");

		// 验证：最终应该能看到解析后的结构化参数
		expect(clean).toContain("exec");
	});

	test("场景5: toolCallEnd 时 streamRegion 状态清理", () => {
		captureStart();

		renderer.roundStart(1, 10, 3);

		// 第一轮：tool call
		renderer.toolCallArgChunk(0, "exec", '{"script":"ls"}');
		renderer.contentEnd();
		renderer.toolCallStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls" },
		});
		renderer.toolCallEnd({
			type: "tool_result",
			tool: "exec",
			call: { id: "call_1", tool: "exec", args: { script: "ls" } },
			exitCode: 0,
			stdout: "file1.txt",
			stderr: "",
			durationMs: 50,
		});

		// 第二轮
		renderer.roundStart(2, 10, 5);
		renderer.toolCallArgChunk(0, "write", '{"path":"out.txt","content":"data"}');
		renderer.contentEnd();
		renderer.toolCallStart({
			id: "call_2",
			tool: "write",
			args: { path: "out.txt", content: "data" },
		});
		renderer.toolCallEnd({
			type: "tool_result",
			tool: "write",
			call: { id: "call_2", tool: "write", args: { path: "out.txt", content: "data" } },
			success: true,
			error: null,
		});

		const result = captureStop();
		const clean = stripAnsi(result);

		console.log("=== 场景5 输出 ===");
		console.log(clean);
		console.log("=== END ===");

		// 验证：第二轮不应残留第一轮的 stream 状态
		// 每轮的工具参数只应渲染一次
	});

	test("场景6: edit 工具的特殊渲染路径", () => {
		captureStart();

		renderer.roundStart(1, 10, 3);

		// edit 工具流式参数
		renderer.toolCallArgChunk(0, "edit", '{"path":"src/index.ts","intent":"fix bug","instructions":"change x to y"}');
		renderer.contentEnd();

		// edit 的 toolCallStart 有特殊渲染（只显示 path + intent）
		renderer.toolCallStart({
			id: "call_1",
			tool: "edit",
			args: { path: "src/index.ts", intent: "fix bug" },
		});

		renderer.toolCallEnd({
			type: "tool_result",
			tool: "edit",
			call: { id: "call_1", tool: "edit", args: { path: "src/index.ts", intent: "fix bug" } },
			success: true,
			diff: { added: 5, removed: 3, chunks: [] },
			durationMs: 2000,
			rounds: 2,
			error: null,
			feedback: null,
		});

		const result = captureStop();
		const clean = stripAnsi(result);

		console.log("=== 场景6 输出 ===");
		console.log(clean);
		console.log("=== END ===");

		// edit 应该被 skip（因为 streamRegion 已渲染），但 streamRegion 渲染的是完整参数
		// 而 toolCallStart 的 edit 特殊路径只显示 path + intent
		// 这里可能有不一致
	});
});
