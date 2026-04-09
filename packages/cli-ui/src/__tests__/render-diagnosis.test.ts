/**
 * 渲染问题诊断测试 — 精确追踪每次 clear+rewrite 的 ANSI 指令序列
 *
 * 不使用虚拟终端，而是直接捕获原始 ANSI 输出，分析：
 * 1. 每次 toolCallArgChunk 触发多少次 cursorUp + clearDown
 * 2. clear 和 rewrite 之间的"空白窗口"有多大
 * 3. 高频重绘的帧率
 */

import { afterEach, describe, test } from "bun:test";
import { saveStderr, restoreStderr } from "./test-helpers.ts";

const saved = saveStderr();

interface WriteEvent {
	data: string;
	timestamp: number;
}

function setupCapture(cols: number): WriteEvent[] {
	const events: WriteEvent[] = [];
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
		if (typeof chunk === "string") {
			events.push({ data: chunk, timestamp: performance.now() });
		}
		return true;
	};
	return events;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: needed
const CSI_RE = /\x1b\[([0-9;]*?)([A-Za-z])/g;

/** 分析事件流中的 ANSI 指令 */
function analyzeEvents(events: WriteEvent[]) {
	let clearCount = 0;
	const rewriteCount = 0;
	let totalCursorUp = 0;

	for (const event of events) {
		CSI_RE.lastIndex = 0;
		let match = CSI_RE.exec(event.data);
		while (match !== null) {
			const params = match[1] ?? "";
			const cmd = match[2] ?? "";
			if (cmd === "A") {
				totalCursorUp += Number.parseInt(params, 10) || 1;
				clearCount++;
			}
			if (cmd === "J") {
				// clearDown
			}
			match = CSI_RE.exec(event.data);
		}
	}

	return { clearCount, rewriteCount, totalCursorUp };
}

describe("渲染诊断", () => {
	afterEach(() => restoreStderr(saved));

	test("单字符 chunk：每个字符触发一次完整 clear+rewrite", async () => {
		const events = setupCapture(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		const json = '{"script":"echo hello"}';
		for (let i = 0; i < json.length; i++) {
			if (i === 0) renderer.toolCallArgStart(0, "exec");
			renderer.toolCallArgChunk(0, json[i] as string);
		}

		const stats = analyzeEvents(events);
		console.log(`JSON 长度: ${json.length} 字符`);
		console.log(`clear 次数: ${stats.clearCount}`);
		console.log(`总 cursorUp 行数: ${stats.totalCursorUp}`);
		console.log(`write 事件数: ${events.length}`);

		// 每个字符都触发 streamRegion.clear() + rewrite
		// 这意味着 23 个字符 → 22 次 clear（第一次没有旧内容）
		// 在真实终端中，22 次高频的"擦除整个区域→重画"就是闪烁！
		console.log(
			`\n⚠️ ${json.length} 个字符产生了 ${stats.clearCount} 次 clear+rewrite 循环`,
		);
		console.log(`   真实终端中每次 clear 都会短暂显示空白 → 可见闪烁`);
	});

	test("追踪 contentEnd 的 clear → rewrite 间隙", async () => {
		const events = setupCapture(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		const json = '{"script":"echo hello","runtime":"cmd"}';
		for (let i = 0; i < json.length; i++) {
			if (i === 0) renderer.toolCallArgStart(0, "exec");
			renderer.toolCallArgChunk(0, json[i] as string);
		}

		// 标记 contentEnd 之前
		const preContentEnd = events.length;
		renderer.streamEnd();
		const postContentEnd = events.length;

		// 分析 contentEnd 期间的事件
		const contentEndEvents = events.slice(preContentEnd, postContentEnd);
		console.log(`contentEnd 期间的 write 事件数: ${contentEndEvents.length}`);

		// 找到 clear（cursorUp+clearDown）和 rewrite（实际内容）
		let clearIdx = -1;
		let firstContentIdx = -1;
		for (let i = 0; i < contentEndEvents.length; i++) {
			if (
				contentEndEvents[i]?.data.includes("\x1b[") &&
				contentEndEvents[i]?.data.includes("A")
			) {
				clearIdx = i;
			}
			if (firstContentIdx === -1 && contentEndEvents[i]?.data.includes("▸")) {
				firstContentIdx = i;
			}
		}

		console.log(`clear 事件索引: ${clearIdx}`);
		console.log(`首个内容事件索引: ${firstContentIdx}`);
		if (clearIdx >= 0 && firstContentIdx >= 0) {
			const gap = firstContentIdx - clearIdx;
			console.log(`clear 到 rewrite 之间的事件数: ${gap}`);
			console.log(`\n→ 这 ${gap} 个事件期间，屏幕上是空白/部分内容`);
			console.log(`→ 如果终端在此期间刷新，用户就看到闪烁`);
		}
	});

	test("量化：流式阶段 vs 最终阶段的行数差异", async () => {
		const events = setupCapture(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 多行值 — 流式阶段只显示尾部6行，最终显示全部
		const longValue = Array.from(
			{ length: 15 },
			(_, i) => `line ${i + 1}`,
		).join("\\n");
		const json = `{"output":"${longValue}"}`;

		// 流式阶段
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, json);

		// 统计流式阶段的行数（从上一次 cursorUp 的参数推断）
		let lastCursorUp = 0;
		for (const event of events) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence matching
			const match = event.data.match(/\x1b\[(\d+)A/);
			if (match) lastCursorUp = Number(match[1]);
		}

		const streamLineCount = lastCursorUp; // 不精确，但可以近似

		// contentEnd
		const preEnd = events.length;
		renderer.streamEnd();

		// 统计最终输出的行数
		let finalLineCount = 0;
		for (let i = preEnd; i < events.length; i++) {
			const newlines = (events[i]?.data.match(/\n/g) || []).length;
			finalLineCount += newlines;
		}

		console.log(`流式阶段显示行数(approx): ${streamLineCount}`);
		console.log(`最终阶段输出行数: ${finalLineCount}`);
		console.log(`差异: ${finalLineCount - streamLineCount}`);
		console.log(
			`\n→ contentEnd 时 clear 了 ${streamLineCount} 行，但重写了 ${finalLineCount} 行`,
		);
		console.log(`→ 如果最终 > 流式 → 内容"跳"出来，视觉上不连续`);
		console.log(`→ 如果最终 < 流式 → 不可能发生（最终显示更多）`);
	});
});
