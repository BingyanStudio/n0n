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

import { beforeEach, describe, expect, test } from "bun:test";
import { RichRenderer } from "../rich-renderer.ts";

// 捕获所有 stderr 输出用于断言
let output: string;
const originalWrite = process.stderr.write;

function captureStart() {
	output = "";
	process.stderr.write = (chunk: string | Uint8Array) => {
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

function _sleep(ms: number) {
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
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, '{"sc');
		renderer.toolCallArgChunk(0, 'ript":');
		renderer.toolCallArgChunk(0, '"ls -la"');
		renderer.toolCallArgChunk(0, ',"runtime":');
		renderer.toolCallArgChunk(0, '"sh"}');

		// 流结束
		renderer.streamEnd();

		// agentLoop 解析完成后调用 toolCallStart
		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls -la", runtime: "sh" },
		});

		// 工具执行完成
		renderer.toolExecEnd({
			type: "tool_result",
			tool: "exec",
			status: "completed" as const,
			call: {
				id: "call_1",
				tool: "exec",
				args: { script: "ls -la", runtime: "sh" },
			},
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
		renderer.contentChunk("我来执行");
		renderer.contentChunk("一下命令");

		renderer.contentEnd();

		// 然后输出 tool call
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, '{"script":"echo hello"}');

		// 流结束
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "echo hello" },
		});

		renderer.toolExecEnd({
			type: "tool_result",
			tool: "exec",
			status: "completed" as const,
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
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, '{"script":"ls"}');
		renderer.toolCallArgStart(1, "write");
		renderer.toolCallArgChunk(1, '{"path":"test.txt"');
		renderer.toolCallArgChunk(1, ',"content":"hello"}');

		// 流结束
		renderer.streamEnd();

		// 两个 toolCallStart
		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls" },
		});

		renderer.toolExecStart({
			id: "call_2",
			tool: "write",
			args: { path: "test.txt", content: "hello" , is_completed_and_i_will_immediately_call_the_next_tool: true },
		});

		// 两个 toolCallEnd
		renderer.toolExecEnd({
			type: "tool_result",
			tool: "exec",
			status: "completed" as const,
			call: { id: "call_1", tool: "exec", args: { script: "ls" } },
			exitCode: 0,
			stdout: "file1.txt",
			stderr: "",
			durationMs: 50,
		});

		renderer.toolExecEnd({
			type: "tool_result",
			tool: "write",
			call: {
				id: "call_2",
				tool: "write",
				args: { path: "test.txt", content: "hello" , is_completed_and_i_will_immediately_call_the_next_tool: true },
			},
			status: "completed",
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
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, "{");
		renderer.toolCallArgChunk(0, '"');
		renderer.toolCallArgChunk(0, "scr");
		renderer.toolCallArgChunk(0, "ipt");
		renderer.toolCallArgChunk(0, '":');
		renderer.toolCallArgChunk(0, '"echo ');
		renderer.toolCallArgChunk(0, 'hello"');
		renderer.toolCallArgChunk(0, "}");

		renderer.streamEnd();

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
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, '{"script":"ls"}');
		renderer.streamEnd();
		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls" },
		});
		renderer.toolExecEnd({
			type: "tool_result",
			tool: "exec",
			status: "completed" as const,
			call: { id: "call_1", tool: "exec", args: { script: "ls" } },
			exitCode: 0,
			stdout: "file1.txt",
			stderr: "",
			durationMs: 50,
		});

		// 第二轮
		renderer.roundStart(2, 10, 5);
		renderer.toolCallArgStart(0, "write");
		renderer.toolCallArgChunk(0, '{"path":"out.txt","content":"data"}');
		renderer.streamEnd();
		renderer.toolExecStart({
			id: "call_2",
			tool: "write",
			args: { path: "out.txt", content: "data" , is_completed_and_i_will_immediately_call_the_next_tool: true },
		});
		renderer.toolExecEnd({
			type: "tool_result",
			tool: "write",
			call: {
				id: "call_2",
				tool: "write",
				args: { path: "out.txt", content: "data" , is_completed_and_i_will_immediately_call_the_next_tool: true },
			},
			status: "completed",
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
		renderer.toolCallArgStart(0, "edit");
		renderer.toolCallArgChunk(
			0,
			'{"path":"src/index.ts","intent":"fix bug","instructions":"change x to y"}',
		);
		renderer.streamEnd();

		// edit 的 toolCallStart 有特殊渲染（只显示 path + intent）
		renderer.toolExecStart({
			id: "call_1",
			tool: "edit",
			args: { path: "src/index.ts", intent: "fix bug" , is_completed_and_i_will_immediately_call_the_next_tool: true },
		});

		renderer.toolExecEnd({
			type: "tool_result",
			tool: "edit",
			call: {
				id: "call_1",
				tool: "edit",
				args: { path: "src/index.ts", intent: "fix bug" , is_completed_and_i_will_immediately_call_the_next_tool: true },
			},
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
