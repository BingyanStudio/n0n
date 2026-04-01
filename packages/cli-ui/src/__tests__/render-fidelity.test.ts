/**
 * RichRenderer 渲染保真测试 — 虚拟终端验证
 *
 * 将 RichRenderer 的 stderr 输出接入 VirtualTerminal，
 * 在真实 TTY 模式下验证流式渲染的最终画面是否正确。
 *
 * 目标：复现生产环境中的闪烁/残留问题。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { VirtualTerminal } from "./virtual-terminal.ts";

// 保存原始值用于恢复
const origWrite = process.stderr.write;
const origCols = process.stderr.columns;
const origTTY = process.stderr.isTTY;

function setupVT(cols: number): VirtualTerminal {
	const vt = new VirtualTerminal(cols, 500);
	Object.defineProperty(process.stderr, "isTTY", {
		value: true,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, "columns", {
		value: cols,
		writable: true,
		configurable: true,
	});
	process.stderr.write = (chunk: string | Uint8Array) => {
		if (typeof chunk === "string") vt.feed(chunk);
		return true;
	};
	return vt;
}

function teardown(): void {
	process.stderr.write = origWrite;
	Object.defineProperty(process.stderr, "columns", {
		value: origCols,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, "isTTY", {
		value: origTTY,
		writable: true,
		configurable: true,
	});
}

/** 将完整 JSON 字符串按随机位置切分为 chunks */
function randomChunks(json: string, seed: number): string[] {
	const chunks: string[] = [];
	let pos = 0;
	let s = seed;
	while (pos < json.length) {
		// 简易 PRNG
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		const size = (s % 5) + 1; // 1-5 字符
		chunks.push(json.slice(pos, pos + size));
		pos += size;
	}
	return chunks;
}

/** 去除 ANSI 控制序列，只保留可见文本 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

describe("RichRenderer 虚拟终端保真测试", () => {
	afterEach(teardown);

	test("基础流式渲染 — 最终画面不应有残留", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 流式 tool call
		const json = '{"script":"echo hello","runtime":"cmd"}';
		const chunks = randomChunks(json, 42);
		renderer.toolCallArgStart(0, "exec");
		for (const chunk of chunks) {
			renderer.toolCallArgChunk(0, chunk);
		}
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "echo hello", runtime: "cmd" },
		});
		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "exec",
			timedOut: false,
			call: {
				id: "call_1",
				tool: "exec",
				args: { script: "echo hello", runtime: "cmd" },
			},
			stdout: "hello",
			stderr: "",
			exitCode: 0,
			durationMs: 100,
		});

		const lines = vt.getVisibleLines();
		const cleanLines = lines.map((l) => stripAnsi(l));

		// 检查最终画面中不应有 "(streaming…)" 残留
		for (const line of cleanLines) {
			expect(line).not.toContain("(streaming");
		}

		// 应有结果行
		const hasResult = cleanLines.some(
			(l) => l.includes("exec") && l.includes("exit=0"),
		);
		expect(hasResult).toBe(true);

		// 不应有重复的 "▸ exec" 行
		const toolHeaders = cleanLines.filter((l) =>
			l.trimStart().startsWith("▸ exec"),
		);
		expect(toolHeaders.length).toBe(1);
	});

	test("CJK 内容流式渲染 — wrap 后 clear 不应残留", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 含中文的 submit 工具参数
		const json =
			'{"type":"completed","summary":"已完成 PR #61 的清理：1. 关闭 PR #61，附带说明关闭原因（核心功能已被 PR #75/#76 覆盖，分支严重过时）2. 删除远程分支","files_changed":[]}';
		const chunks = randomChunks(json, 123);
		renderer.toolCallArgStart(0, "submit");
		for (const chunk of chunks) {
			renderer.toolCallArgChunk(0, chunk);
		}
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "submit",
			args: JSON.parse(json),
		});
		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "submit",
			call: { id: "call_1", tool: "submit", args: JSON.parse(json) },
			cleanedResult: null,
		});

		const lines = vt.getVisibleLines();
		const cleanLines = lines.map((l) => stripAnsi(l));

		// 不应有 streaming 残留
		for (const line of cleanLines) {
			expect(line).not.toContain("(streaming");
		}

		// 不应有重复的工具头
		const toolHeaders = cleanLines.filter((l) =>
			l.trimStart().startsWith("▸ submit"),
		);
		expect(toolHeaders.length).toBe(1);
	});

	test("随机 chunk 分割 fuzz（多种子）— 最终画面一致", async () => {
		const _vt0 = setupVT(80);
		await import("../rich-renderer.ts");
		teardown();

		// 用不同种子跑同一场景，收集最终画面
		const json = '{"script":"ls -la","runtime":"cmd","timeout":"30"}';
		const finalScreens: string[][] = [];

		for (const seed of [1, 42, 100, 999, 65535]) {
			const vt = setupVT(80);
			const { RichRenderer } = await import("../rich-renderer.ts");
			const renderer = new RichRenderer();

			renderer.roundStart(1, 10, 3);
			const chunks = randomChunks(json, seed);
			renderer.toolCallArgStart(0, "exec");
			for (const chunk of chunks) {
				renderer.toolCallArgChunk(0, chunk);
			}
			renderer.toolCallArgEnd(0, {
				id: "call_1",
				tool: "exec",
				args: JSON.parse(json),
			} as any);
			renderer.streamEnd();
			renderer.toolExecStart({
				id: "call_1",
				tool: "exec",
				args: JSON.parse(json),
			});
			renderer.toolExecEnd({
				type: "tool_result" as const,
				tool: "exec",
				timedOut: false,
				call: {
					id: "call_1",
					tool: "exec",
					args: JSON.parse(json),
				},
				stdout: "output",
				stderr: "",
				exitCode: 0,
				durationMs: 50,
			});

			const cleanLines = vt.getVisibleLines().map((l) => stripAnsi(l));
			finalScreens.push(cleanLines);
			teardown();
		}

		// 所有种子的最终画面应该相同
		const reference = finalScreens[0];
		for (let i = 1; i < finalScreens.length; i++) {
			expect(finalScreens[i]).toEqual(reference);
		}
	});

	test("极细粒度 chunk（单字符）— 不应崩溃或残留", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 每次只发 1 个字符
		const json = '{"script":"echo hi"}';
		for (let i = 0; i < json.length; i++) {
			if (i === 0) renderer.toolCallArgStart(0, "exec");
			renderer.toolCallArgChunk(0, json[i]!);
		}
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "echo hi" },
		});

		const lines = vt.getVisibleLines();
		const cleanLines = lines.map((l) => stripAnsi(l));

		// 不应有 streaming 残留
		for (const line of cleanLines) {
			expect(line).not.toContain("(streaming");
		}
	});

	test("窄终端（40列）+ CJK — wrap 边界验证", async () => {
		const vt = setupVT(40);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		const json = '{"summary":"关闭并清理远程分支和本地引用完成所有操作"}';
		const chunks = randomChunks(json, 77);
		renderer.toolCallArgStart(0, "submit");
		for (const chunk of chunks) {
			renderer.toolCallArgChunk(0, chunk);
		}
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "submit",
			args: JSON.parse(json),
		});
		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "submit",
			call: { id: "call_1", tool: "submit", args: JSON.parse(json) },
			cleanedResult: null,
		});

		const lines = vt.getVisibleLines();
		const cleanLines = lines.map((l) => stripAnsi(l));

		// 不应有 streaming 残留
		for (const line of cleanLines) {
			expect(line).not.toContain("(streaming");
		}

		// 应有结果行
		const hasResult = cleanLines.some((l) => l.includes("submit"));
		expect(hasResult).toBe(true);
	});
});
