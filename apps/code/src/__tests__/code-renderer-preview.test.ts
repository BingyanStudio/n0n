/**
 * CodeRenderer 流式 write 预览测试
 *
 * 验证 partial-json 解析下 path 锁定时机的正确性：
 * path 值必须在 content key 出现后才锁定，避免截断值导致垃圾文件。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import type { ToolCallRecord } from "@n0n/types";
import { CodeRenderer } from "../code-renderer.ts";
import { formatSubmitResult } from "../submit-formatter.ts";
import type { CodeResult } from "../schema.ts";

// ── 测试用临时目录 ──
const TEST_WORKSPACE = join(import.meta.dir, ".tmp-preview-test");
const TEST_TEMP = join(TEST_WORKSPACE, ".temp");
const TEST_PATHS = { workspace: TEST_WORKSPACE, temp: TEST_TEMP };

function cleanup() {
	if (existsSync(TEST_WORKSPACE)) {
		rmSync(TEST_WORKSPACE, { recursive: true, force: true });
	}
}

/** 列出工作区中所有文件（递归） */
function listFiles(dir: string, prefix = ""): string[] {
	if (!existsSync(dir)) return [];
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const e of entries) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) {
			files.push(...listFiles(join(dir, e.name), rel));
		} else {
			files.push(rel);
		}
	}
	return files;
}

// ── Mock stderr 避免终端输出 ──
const origWrite = process.stderr.write;
const origCols = process.stderr.columns;
const origTTY = process.stderr.isTTY;

beforeEach(() => {
	cleanup();
	mkdirSync(TEST_WORKSPACE, { recursive: true });
	process.stderr.write = () => true;
	Object.defineProperty(process.stderr, "isTTY", {
		value: false,
		writable: true,
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
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
});

/** 模拟流式 tool call 参数传输 */
function simulateStream(
	renderer: CodeRenderer,
	index: number,
	toolName: string,
	chunks: string[],
	finalArgs?: Record<string, unknown>,
) {
	renderer.toolCallArgStart(index, toolName);
	for (const chunk of chunks) {
		renderer.toolCallArgChunk(index, chunk);
	}
	if (finalArgs) {
		renderer.toolCallArgEnd(index, {
			id: `call_${index}`,
			tool: toolName,
			args: finalArgs,
		} as ToolCallRecord);
	}
}

describe("CodeRenderer 流式 write 预览", () => {
	test("BUG 复现：path 不应在值未完整时被锁定", () => {
		const renderer = new CodeRenderer(TEST_PATHS);

		// 模拟 LLM 逐 chunk 输出 {"path": "tsconfig.json", "content": "{}"}
		simulateStream(
			renderer,
			0,
			"write",
			[
				'{"pa',
				'th": "ts', // partial-json 解析出 path:"ts"（截断！）
				"config.json",
				'", "content": "',
				"{}",
				'"}',
			],
			{ path: "tsconfig.json", content: "{}" },
		);

		const files = listFiles(TEST_WORKSPACE);
		expect(files).not.toContain("ts");
		expect(files).toContain("tsconfig.json");
	});

	test("path 在 content key 出现后才锁定", () => {
		const renderer = new CodeRenderer(TEST_PATHS);

		renderer.toolCallArgStart(0, "write");
		renderer.toolCallArgChunk(0, '{"path": "sr');
		renderer.toolCallArgChunk(0, "c/index.ts");

		// content 尚未出现，不应有文件
		expect(listFiles(TEST_WORKSPACE)).toEqual([]);

		renderer.toolCallArgChunk(0, '", "content": "hel');
		renderer.toolCallArgChunk(0, 'lo"');

		renderer.toolCallArgEnd(0, {
			id: "call_0",
			tool: "write",
			args: { path: "src/index.ts", content: "hello" },
		} satisfies ToolCallRecord);

		const files = listFiles(TEST_WORKSPACE);
		expect(files).not.toContain("sr");
		expect(files).toContain("src/index.ts");
	});

	test("非 write 工具不触发预览", () => {
		const renderer = new CodeRenderer(TEST_PATHS);

		simulateStream(renderer, 0, "exec", ['{"script": "echo hello"}'], {
			script: "echo hello",
		});

		expect(listFiles(TEST_WORKSPACE)).toEqual([]);
	});

	test("流中断时 path 未完整不写入", () => {
		const renderer = new CodeRenderer(TEST_PATHS);

		renderer.toolCallArgStart(0, "write");
		renderer.toolCallArgChunk(0, '{"path": "te');
		renderer.streamEnd();

		expect(listFiles(TEST_WORKSPACE)).toEqual([]);
	});

	test("aborted 时清理状态不触发额外写入", () => {
		const renderer = new CodeRenderer(TEST_PATHS);

		// path 和 content 都已出现，流式预览已触发写入
		renderer.toolCallArgStart(0, "write");
		renderer.toolCallArgChunk(0, '{"path": "test.txt", "content": "data"');

		// 此时 test.txt 已被流式写入（path+content 都完整）
		expect(listFiles(TEST_WORKSPACE)).toContain("test.txt");

		// aborted 只是清理内部状态，不会额外写入
		renderer.aborted();

		// 文件仍存在（已写入的不会被撤回），但状态已清理
		expect(listFiles(TEST_WORKSPACE)).toContain("test.txt");
	});
});

describe("formatSubmitResult 单元测试", () => {
	test("completed 仅 summary", () => {
		const md = formatSubmitResult({ type: "completed", summary: "done" } satisfies CodeResult);
		expect(md).toContain("# ✅ 任务完成");
		expect(md).toContain("done");
		expect(md).not.toContain("## 下一步");
	});

	test("completed 带 next_step", () => {
		const md = formatSubmitResult({
			type: "completed",
			summary: "done",
			next_step: "review",
		} satisfies CodeResult);
		expect(md).toContain("## 下一步");
		expect(md).toContain("review");
	});

	test("ask_user 完整选项", () => {
		const md = formatSubmitResult({
			type: "ask_user",
			question: "选哪个？",
			options: [
				{ choice: "A", affect: "影响A" },
				{ choice: "B", affect: "影响B" },
			],
		} satisfies CodeResult);
		expect(md).toContain("# ❓ 需要确认");
		expect(md).toContain("选哪个？");
		expect(md).toContain("### 1. A");
		expect(md).toContain("> 影响A");
		expect(md).toContain("### 2. B");
	});

	test("request_assist 完整检查列表", () => {
		const md = formatSubmitResult({
			type: "request_assist",
			content: "需要帮助",
			checklist: [
				{ label: "检查项1", detail: "详情1" },
				{ label: "检查项2" },
			],
		} satisfies CodeResult);
		expect(md).toContain("# 🔧 请求协助");
		expect(md).toContain("- [ ] 检查项1");
		expect(md).toContain("> 详情1");
		expect(md).toContain("- [ ] 检查项2");
	});
});
