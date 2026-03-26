/**
 * 视觉测试脚本：在真实 TTY 下逐步模拟流式 tool call 渲染
 *
 * 用法：bun run packages/cli-ui/src/__tests__/toolcall-visual.ts
 *
 * 通过 sleep 控制节奏，在终端中直接观察渲染效果。
 * 每个场景之间有分隔线和暂停。
 */

import { RichRenderer } from "../rich-renderer.ts";

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

const renderer = new RichRenderer();

async function scenario1() {
	console.error("\n══════ 场景1: 纯 tool call（无 content）══════");
	await sleep(500);

	renderer.roundStart(1, 10, 3);
	await sleep(200);

	// 模型直接输出 tool_call_delta，没有 content token
	const chunks = ['{"sc', 'ript":', '"ls -la"', ',"runtime":', '"sh"}'];
	for (const chunk of chunks) {
		renderer.toolCallArgChunk(0, chunk === chunks[0] ? "exec" : undefined, chunk);
		await sleep(150);
	}

	await sleep(300);
	renderer.contentEnd();
	await sleep(200);

	renderer.toolCallStart({
		id: "call_1",
		tool: "exec",
		args: { script: "ls -la", runtime: "sh" },
	});
	await sleep(100);

	renderer.toolCallEnd({
			type: "tool_result",
		tool: "exec",
		call: { id: "call_1", tool: "exec", args: { script: "ls -la", runtime: "sh" } },
		exitCode: 0,
		stdout: "total 0\ndrwxr-xr-x  2 user staff  64 Jan  1 00:00 .",
		stderr: "",
		durationMs: 150,
	});
}

async function scenario2() {
	console.error("\n══════ 场景2: content + tool call ══════");
	await sleep(500);

	renderer.roundStart(2, 10, 5);
	await sleep(200);

	// 先输出 content
	const words = ["我来", "帮你", "执行", "一下", "命令"];
	for (const w of words) {
		renderer.contentToken(w);
		await sleep(100);
	}

	await sleep(200);

	// 然后输出 tool call
	const chunks = ['{"script":', '"echo hello"', ',"runtime":"sh"}'];
	for (const chunk of chunks) {
		renderer.toolCallArgChunk(0, chunk === chunks[0] ? "exec" : undefined, chunk);
		await sleep(150);
	}

	await sleep(300);
	renderer.contentEnd();
	await sleep(200);

	renderer.toolCallStart({
		id: "call_2",
		tool: "exec",
		args: { script: "echo hello", runtime: "sh" },
	});
	await sleep(100);

	renderer.toolCallEnd({
			type: "tool_result",
		tool: "exec",
		call: { id: "call_2", tool: "exec", args: { script: "echo hello", runtime: "sh" } },
		exitCode: 0,
		stdout: "hello\n",
		stderr: "",
		durationMs: 50,
	});
}

async function scenario3() {
	console.error("\n══════ 场景3: 多个并发 tool call ══════");
	await sleep(500);

	renderer.roundStart(3, 10, 7);
	await sleep(200);

	// 两个工具调用交替流式输出
	renderer.toolCallArgChunk(0, "exec", '{"scr');
	await sleep(100);
	renderer.toolCallArgChunk(1, "write", '{"pa');
	await sleep(100);
	renderer.toolCallArgChunk(0, undefined, 'ipt":"ls"}');
	await sleep(100);
	renderer.toolCallArgChunk(1, undefined, 'th":"test.txt","co');
	await sleep(100);
	renderer.toolCallArgChunk(1, undefined, 'ntent":"hello world"}');
	await sleep(300);

	renderer.contentEnd();
	await sleep(200);

	renderer.toolCallStart({
		id: "call_3",
		tool: "exec",
		args: { script: "ls" },
	});

	renderer.toolCallStart({
		id: "call_4",
		tool: "write",
		args: { path: "test.txt", content: "hello world" },
	});
	await sleep(100);

	renderer.toolCallEnd({
			type: "tool_result",
		tool: "exec",
		call: { id: "call_3", tool: "exec", args: { script: "ls" } },
		exitCode: 0,
		stdout: "file1.txt\nfile2.txt",
		stderr: "",
		durationMs: 80,
	});

	await sleep(200);

	renderer.toolCallEnd({
			type: "tool_result",
		tool: "write",
		call: { id: "call_4", tool: "write", args: { path: "test.txt", content: "hello world" } },
		success: true,
			error: null,
	});
}

async function scenario4() {
	console.error("\n══════ 场景4: edit 工具特殊渲染 ══════");
	await sleep(500);

	renderer.roundStart(4, 10, 9);
	await sleep(200);

	// edit 工具流式参数（较长）
	const argChunks = [
		'{"path":',
		'"src/index.ts"',
		',"intent":',
		'"修复类型错误"',
		',"instructions":',
		'"将 string 改为 number"',
		'}',
	];
	for (let i = 0; i < argChunks.length; i++) {
		renderer.toolCallArgChunk(0, i === 0 ? "edit" : undefined, argChunks[i]!);
		await sleep(120);
	}

	await sleep(300);
	renderer.contentEnd();
	await sleep(200);

	renderer.toolCallStart({
		id: "call_5",
		tool: "edit",
		args: { path: "src/index.ts", intent: "修复类型错误" },
	});
	await sleep(100);

	// 模拟 edit 执行过程中的流式输出
	renderer.toolResultChunk("edit", "Analyzing file...\n");
	await sleep(300);
	renderer.toolResultChunk("edit", "Applying changes...\n");
	await sleep(300);

	renderer.toolCallEnd({
			type: "tool_result",
		tool: "edit",
		call: { id: "call_5", tool: "edit", args: { path: "src/index.ts", intent: "修复类型错误" } },
		success: true,
		diff: { added: 3, removed: 2, chunks: [] },
		durationMs: 1500,
		rounds: 1,
			error: null,
			feedback: null,
	});
}

console.error("🔍 RichRenderer 流式 Tool Call 渲染视觉测试");
console.error("   观察每个场景的渲染效果，注意是否有重复/残留/闪烁");
console.error("");

await scenario1();
await sleep(800);
await scenario2();
await sleep(800);
await scenario3();
await sleep(800);
await scenario4();

console.error("\n══════ 测试完毕 ══════\n");
