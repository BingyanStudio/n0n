/**
 * TTY 视觉复现脚本 — 直接在终端运行观察渲染效果
 *
 * 用法：bun run packages/cli-ui/src/__tests__/toolcall-tty-visual.ts
 *
 * 场景A：多参数工具细粒度 chunk（行数从 1 跳到 4 跳到 6）
 * 场景B：超 maxLines 的 write 工具（行数持续增长到 maxLines 后稳定）
 */

import type { ToolCallRecord, ToolResult } from "@n0n/types";
import { RichRenderer } from "../rich-renderer.ts";

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════
// 场景 A：多参数工具 + 细粒度 chunk
// ══════════════════════════════════════════════════════════
async function scenarioA() {
	const renderer = new RichRenderer();
	console.error("\n══════ 场景A：多参数细粒度 chunk ══════");
	await sleep(1000);

	renderer.roundStart(1, 10, 3);
	await sleep(300);

	const chunks: [string | undefined, string][] = [
		["write", '{"'], // streaming...
		[undefined, 'path":"'], // streaming...
		[undefined, 'src/app.ts"'], // path 解析出来 → 行数跳变
		[undefined, ',"content'], // 同上
		[undefined, '":"hello'], // content 出现 → 行数跳变
		[undefined, ' world"'], // 值完整
		[undefined, "}"], // 完整 JSON
	];

	for (const [name, arg] of chunks) {
		if (name) renderer.toolCallArgStart(0, name);
		renderer.toolCallArgChunk(0, arg);
		await sleep(200);
	}

	await sleep(500);
	renderer.streamEnd();
	await sleep(300);

	const call: ToolCallRecord = {
		id: "call_1",
		tool: "write",
		args: { path: "src/app.ts", content: "hello world" },
	};

	renderer.toolExecStart(call.id, call);

	renderer.toolExecEnd(call.id, {
		type: "tool_result",
		tool: "write",
		call,
		status: "completed",
	} satisfies ToolResult);
}

// ══════════════════════════════════════════════════════════
// 场景 B：超 maxLines（12行）的 content
// ══════════════════════════════════════════════════════════
async function scenarioB() {
	const renderer = new RichRenderer();
	console.error("\n══════ 场景B：超 maxLines 截断 ══════");
	await sleep(1000);

	renderer.roundStart(1, 10, 3);
	await sleep(300);

	// 先发 path
	renderer.toolCallArgStart(0, "write");
	renderer.toolCallArgChunk(0, '{"path":"output.txt","content":"');
	await sleep(300);

	// 逐行追加 content（每行一个 chunk）
	for (let i = 1; i <= 20; i++) {
		const sep = i === 1 ? "" : "\\n";
		renderer.toolCallArgChunk(0, `${sep}line ${i}`);
		await sleep(150);
	}

	renderer.toolCallArgChunk(0, '"}');
	await sleep(500);

	renderer.streamEnd();
	await sleep(300);

	const contentStr = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
		"\n",
	);
	const call: ToolCallRecord = {
		id: "call_1",
		tool: "write",
		args: { path: "output.txt", content: contentStr },
	};

	renderer.toolExecStart(call.id, call);

	renderer.toolExecEnd(call.id, {
		type: "tool_result",
		tool: "write",
		call,
		status: "completed",
	} satisfies ToolResult);
}

// ══════════════════════════════════════════════════════════
// 场景 C：连续两个 round，第二个 round 的 roundStart 会被 clear 误删吗？
// ══════════════════════════════════════════════════════════
async function scenarioC() {
	const renderer = new RichRenderer();
	console.error("\n══════ 场景C：连续两轮 tool call ══════");
	await sleep(1000);

	// 第一轮
	renderer.roundStart(1, 10, 3);
	await sleep(200);

	renderer.toolCallArgStart(0, "exec");
	renderer.toolCallArgChunk(0, '{"script":"echo round1"}');
	await sleep(300);

	renderer.streamEnd();

	const execCall: ToolCallRecord = {
		id: "call_1",
		tool: "exec",
		args: { script: "echo round1" },
	};
	renderer.toolExecStart(execCall.id, execCall);
	renderer.toolExecEnd(execCall.id, {
		type: "tool_result",
		tool: "exec",
		call: execCall,
		status: "completed",
		exitCode: 0,
		stdout: "round1\n",
		stderr: "",
		durationMs: 50,
	} satisfies ToolResult);

	await sleep(500);

	// 第二轮
	renderer.roundStart(2, 10, 5);
	await sleep(200);

	// 细粒度 chunk，行数逐步增长
	const chunks: [string | undefined, string][] = [
		["write", '{"path":"'],
		[undefined, 'test.txt"'],
		[undefined, ',"content":"'],
		[undefined, 'line1\\nline2\\nline3"'],
		[undefined, "}"],
	];
	for (const [name, arg] of chunks) {
		if (name) renderer.toolCallArgStart(0, name);
		renderer.toolCallArgChunk(0, arg);
		await sleep(200);
	}

	await sleep(500);
	renderer.streamEnd();

	const writeCall: ToolCallRecord = {
		id: "call_2",
		tool: "write",
		args: { path: "test.txt", content: "line1\nline2\nline3" },
	};
	renderer.toolExecStart(writeCall.id, writeCall);
	renderer.toolExecEnd(writeCall.id, {
		type: "tool_result",
		tool: "write",
		call: writeCall,
		status: "completed",
	} satisfies ToolResult);
}

console.error("🔍 TTY 下 RichRenderer 流式 Tool Call 渲染复现测试");
console.error("   直接观察终端输出是否有残留、闪烁、覆盖上方内容等问题\n");

await scenarioA();
await sleep(1500);
await scenarioB();
await sleep(1500);
await scenarioC();

console.error("\n══════ 测试完毕 ══════\n");
