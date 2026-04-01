/**
 * 终端边界行为差异测试
 *
 * 真实终端在某些边界情况下的行为可能与我们的虚拟终端不同：
 * 1. 恰好填满终端宽度时，光标可能处于"pending wrap"状态
 * 2. \n 在行尾的行为可能不同
 * 3. cursorUp 在 pending wrap 状态下的行为
 *
 * 这些测试通过对比"两种 wrap 模型"来找出差异。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { VirtualTerminal } from "./virtual-terminal.ts";

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

// biome-ignore lint/suspicious/noControlCharactersInRegex: needed
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

describe("终端边界行为", () => {
	afterEach(teardown);

	test("恰好填满行宽 + \\n：LiveRegion 行计数是否正确", async () => {
		// 在真实终端中，写入恰好 cols 个字符后再写 \n：
		// 某些终端：80字符自动wrap到下一行，\n 再换一行 → 实际占 2 行但有1行空行
		// 另一些终端：80字符pending wrap，\n 触发换行 → 实际占 1 行
		//
		// LiveRegion 的 countDisplayLines("A".repeat(80) + "\n") 算出多少？
		const vt = setupVT(80);
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		// 写入恰好 80 字符 + 换行
		region.writeln("A".repeat(80));

		// 检查虚拟终端状态
		const vtLine0 = vt.getLine(0);
		const vtLine1 = vt.getLine(1);
		console.log(`VT line 0: "${vtLine0}" (${vtLine0.length} chars)`);
		console.log(`VT line 1: "${vtLine1}" (${vtLine1.length} chars)`);
		console.log(`VT cursor: row=${vt.cursorRow}, col=${vt.cursorCol}`);

		// 现在 clear 看 cursorUp 移动了多少行
		const writes: string[] = [];
		const _realWrite = process.stderr.write;
		process.stderr.write = (chunk: string | Uint8Array) => {
			if (typeof chunk === "string") {
				writes.push(chunk);
				vt.feed(chunk);
			}
			return true;
		};

		region.clear();

		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence matching
		const cursorUpMatch = writes.join("").match(/\x1b\[(\d+)A/);
		const upN = cursorUpMatch ? Number(cursorUpMatch[1]) : 0;
		console.log(`cursorUp(${upN})`);
		console.log(
			`After clear - cursor: row=${vt.cursorRow}, col=${vt.cursorCol}`,
		);

		// 关键检查：clear 后光标应在 row 0
		// 如果 countDisplayLines 算的是 1（ceil(80/80)=1），cursorUp(1)
		// 但如果真实终端80字符自动换行了，实际占了2行，cursorUp(1)就不够
		console.log(`\n⚠️  如果 upN=1 但实际占2行 → clear 不完全 → 残留！`);
		console.log(`   这就是"恰好填满终端宽度"的经典 off-by-one 问题`);

		// 在我们的虚拟终端中，80字符在80列终端中不会wrap（刚好填满）
		// 但真实终端中，写完第80个字符后光标位置是行末还是下一行开头？
		// 这取决于终端实现。大多数现代终端使用 "deferred wrap"。
	});

	test("对比两种模型：逐字符写入 vs 整行写入", async () => {
		// 真实 LLM 流式输出可能逐字符到达
		// 每个字符都可能触发 toolCallArgChunk → streamRegion.clear() + rewrite
		// 在高频 clear+rewrite 中，如果计算有任何偏差，闪烁就会很明显

		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 逐字符发送，每个字符都触发一次完整的 clear+rewrite
		const json = '{"script":"echo hello"}';
		let frameCount = 0;
		const frameSizes: number[] = [];

		for (let i = 0; i < json.length; i++) {
			if (i === 0) renderer.toolCallArgStart(0, "exec");
			renderer.toolCallArgChunk(0, json[i]!);
			frameCount++;
			frameSizes.push(vt.getVisibleLines().length);
		}

		console.log(`总帧数: ${frameCount}`);
		console.log(`每帧行数: [${frameSizes.join(", ")}]`);
		console.log(
			`行数波动: ${Math.min(...frameSizes)} ~ ${Math.max(...frameSizes)}`,
		);

		// 每一帧都触发了 clear+rewrite，如果行数波动大，视觉上就是闪烁
		// 这本身就是性能问题——高频重绘导致视觉闪烁
		const fluctuations = frameSizes.filter(
			(s, i) => i > 0 && s !== frameSizes[i - 1],
		).length;
		console.log(`行数变化次数: ${fluctuations}/${frameCount - 1}`);

		// 验证最终状态
		const finalLines = vt.getVisibleLines().map((l) => stripAnsi(l));
		console.log(`\n最终屏幕:`);
		for (const l of finalLines) console.log(`  "${l}"`);
	});

	test("toolResultChunk 追加 vs toolRegion 行计数", async () => {
		// toolResultChunk 向 toolRegion 追加行但不 clear
		// 如果行计数累积错误，后续 reset 可能出问题
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);
		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: { script: "ls" },
		});

		// 模拟 exec 工具的流式输出（多行，包含中文）
		renderer.toolExecChunk("exec", "file1.ts\n");
		renderer.toolExecChunk("exec", "文件2.ts\n");
		renderer.toolExecChunk("exec", "目录/子文件.ts\n");

		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "exec",
			status: "completed" as const,
			call: { id: "call_1", tool: "exec", args: { script: "ls" } },
			stdout: "file1.ts\n文件2.ts\n目录/子文件.ts\n",
			stderr: "",
			exitCode: 0,
			durationMs: 50,
		});

		const finalLines = vt.getVisibleLines().map((l) => stripAnsi(l));
		console.log("toolResultChunk 最终屏幕:");
		for (const l of finalLines) console.log(`  "${l}"`);

		// 不应有空白间隔或重复行
		const toolOutputLines = finalLines.filter((l) => l.includes("│"));
		console.log(`工具输出行数: ${toolOutputLines.length}`);
	});

	test("content token + 流式 tool call 交替 — 换行对齐", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 模型先输出一些文字
		renderer.contentChunk("我来");
		renderer.contentChunk("执行");
		renderer.contentChunk("命令");
		renderer.contentEnd();

		// 然后切换到 tool call
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, '{"script"');
		renderer.toolCallArgChunk(0, ':"ls"}');
		renderer.streamEnd();

		const finalLines = vt.getVisibleLines().map((l) => stripAnsi(l));
		console.log("content + tool 混合最终屏幕:");
		for (const l of finalLines) console.log(`  "${l}"`);

		// content 和 tool 之间应该有换行分隔
		const contentIdx = finalLines.findIndex((l) => l.includes("我来执行命令"));
		const toolIdx = finalLines.findIndex((l) => l.includes("▸ exec"));
		console.log(`content行: ${contentIdx}, tool行: ${toolIdx}`);

		if (contentIdx >= 0 && toolIdx >= 0) {
			expect(toolIdx).toBeGreaterThan(contentIdx);
		}
	});
});
