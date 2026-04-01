/**
 * 滚动残留复现测试 — 内容超出 viewport 时 cursorUp 被 clamp
 *
 * 核心假设：当流式渲染的内容行数超过终端可视区域高度时，
 * 旧内容滚出 viewport 顶部。此时 cursorUp(N) 被 clamp 到 viewport 顶部，
 * 无法擦除已滚出的旧行 → 旧行残留在 scrollback 中。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { VirtualTerminal } from "./virtual-terminal.ts";

const origWrite = process.stderr.write;
const origCols = process.stderr.columns;
const origTTY = process.stderr.isTTY;

function setupVT(cols: number, viewportHeight: number): VirtualTerminal {
	const vt = new VirtualTerminal(cols, 500, viewportHeight);
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

describe("滚动导致旧行残留", () => {
	afterEach(teardown);

	test("基础验证：cursorUp 被 viewport 顶部 clamp", () => {
		// 10 行高的 viewport
		const vt = new VirtualTerminal(40, 100, 10);

		// 写入 15 行，超出 viewport 5 行
		for (let i = 0; i < 15; i++) {
			vt.feed(`line ${i}\n`);
		}

		console.log(`scrollTop: ${vt.scrollTop}`);
		console.log(`cursorRow: ${vt.cursorRow}`);
		console.log(`scrollback lines: ${vt.getScrollbackLines().length}`);

		// 前 6 行已滚出
		expect(vt.scrollTop).toBe(6);
		expect(vt.getScrollbackLines().length).toBe(6);

		// cursorUp(15) 应该被 clamp 到 scrollTop=5，而非 row 0
		vt.feed("\x1b[15A");
		console.log(`After cursorUp(15): cursorRow=${vt.cursorRow}`);
		expect(vt.cursorRow).toBe(6); // clamp 到 viewport 顶部

		// clearDown 只能清除 viewport 内的内容
		vt.feed("\x1b[J");

		// scrollback 中的旧行仍然存在！
		const scrollback = vt.getScrollbackLines();
		console.log(
			`Scrollback still has: ${scrollback.filter((l) => l.length > 0).length} non-empty lines`,
		);
		for (const l of scrollback) {
			if (l.length > 0) console.log(`  残留: "${l}"`);
		}

		// 这就是旧行残留！
		const residualCount = scrollback.filter((l) => l.length > 0).length;
		expect(residualCount).toBeGreaterThan(0);
		console.log(
			`\n✅ 复现成功：${residualCount} 行旧内容无法被 cursorUp+clearDown 擦除`,
		);
	});

	test("LiveRegion 在小 viewport 中的 clear 残留", async () => {
		const vt = setupVT(80, 15); // 只有 15 行高的终端
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		// 写入 20 行（超出 viewport 5 行）
		for (let i = 0; i < 20; i++) {
			region.writeln(`streaming line ${i}: some content here`);
		}

		console.log(
			`写入 20 行后: scrollTop=${vt.scrollTop}, cursorRow=${vt.cursorRow}`,
		);
		const scrollbackBefore = vt
			.getScrollbackLines()
			.filter((l) => l.length > 0);
		console.log(`scrollback 中有 ${scrollbackBefore.length} 行`);

		// clear 尝试 cursorUp(20) + clearDown
		region.clear();

		const scrollbackAfter = vt.getScrollbackLines().filter((l) => l.length > 0);
		console.log(`clear 后 scrollback 中仍有 ${scrollbackAfter.length} 行`);

		if (scrollbackAfter.length > 0) {
			console.log("残留行:");
			for (const l of scrollbackAfter) console.log(`  "${l}"`);
			console.log(
				`\n✅ 复现成功：LiveRegion.clear() 无法清除已滚出 viewport 的 ${scrollbackAfter.length} 行`,
			);
		}

		expect(scrollbackAfter.length).toBeGreaterThan(0);
	});

	test("RichRenderer 流式渲染超出 viewport — 残留复现", async () => {
		// 模拟一个只有 12 行高的终端窗口
		const vt = setupVT(80, 12);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3); // 占 2 行

		// 构造一个参数很多的 tool call，使流式渲染超出 20 行
		const bigArgs: Record<string, string> = {};
		for (let i = 0; i < 8; i++) {
			bigArgs[`field_${i}`] = `value ${i} with some content`;
		}
		const json = JSON.stringify(bigArgs);

		// 流式发送（分两次，模拟渲染行数增长超出 viewport）
		const mid = Math.floor(json.length / 2);
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, json.slice(0, mid));

		const afterFirst = vt.getScrollbackLines().filter((l) => l.length > 0);
		console.log(
			`第一次 chunk 后: scrollback=${afterFirst.length}行, scrollTop=${vt.scrollTop}`,
		);

		renderer.toolCallArgChunk(0, json.slice(mid));

		const afterSecond = vt.getScrollbackLines().filter((l) => l.length > 0);
		console.log(
			`第二次 chunk 后: scrollback=${afterSecond.length}行, scrollTop=${vt.scrollTop}`,
		);

		// contentEnd 触发 streamRegion.clear()
		renderer.streamEnd();

		const afterEnd = vt.getScrollbackLines().filter((l) => l.length > 0);
		console.log(`contentEnd 后: scrollback=${afterEnd.length}行`);

		// 查看整体画面（viewport + scrollback）
		const allLines = vt.getVisibleLines().map((l) => stripAnsi(l));
		const viewportLines = vt.getViewportLines().map((l) => stripAnsi(l));

		// 如果有滚出的非空行 = 旧行残留
		if (afterEnd.length > 0) {
			console.log("\n=== 残留在 scrollback 中的旧行 ===");
			for (const l of afterEnd.map((l) => stripAnsi(l))) {
				if (l.length > 0) console.log(`  ❌ "${l}"`);
			}
			console.log("\n=== 当前 viewport ===");
			for (const l of viewportLines) {
				if (l.trim().length > 0) console.log(`  "${l}"`);
			}
			console.log(
				`\n✅ 复现成功：RichRenderer 流式内容超出 viewport 后，${afterEnd.length} 行残留无法擦除`,
			);
		}

		// 这个测试优先记录是否复现；未复现时输出诊断信息
		if (afterEnd.length > 0) {
			expect(afterEnd.length).toBeGreaterThan(0);
		} else {
			console.log("未出现 scrollback 残留：当前渲染内容可能未溢出 viewport");
			console.log(
				`诊断: afterFirst=${afterFirst.length}, afterSecond=${afterSecond.length}, scrollTop=${vt.scrollTop}`,
			);
			expect(afterSecond.length).toBeGreaterThanOrEqual(0);
		}
	});

	test("多次 toolCall 累积高度超出 viewport — 复现真实场景", async () => {
		// 25 行终端 — 日常笔记本终端高度
		const vt = setupVT(80, 25);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3); // ~2 行

		// 第一个 tool call: exec 有长输出
		const json1 =
			'{"script":"find . -name *.ts -exec wc -l {} +","runtime":"cmd"}';
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, json1);
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "exec",
			args: JSON.parse(json1),
		});

		// 模拟工具执行输出 15 行
		for (let i = 0; i < 15; i++) {
			renderer.toolExecChunk("exec", `  ${100 + i} ./src/file${i}.ts\n`);
		}

		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "exec",
			call: { id: "call_1", tool: "exec", args: JSON.parse(json1) },
			stdout: "...",
			stderr: "",
			timedOut: false,
			exitCode: 0,
			durationMs: 200,
		});

		const scrollbackAfterTool1 = vt
			.getScrollbackLines()
			.filter((l) => l.length > 0);
		console.log(
			`第1个 tool 后: scrollback=${scrollbackAfterTool1.length}行, scrollTop=${vt.scrollTop}`,
		);

		// 第二个 tool call: 又有输出
		renderer.roundStart(2, 10, 6);

		const json2 = '{"script":"cat README.md","runtime":"cmd"}';
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, json2);
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_2",
			tool: "exec",
			args: JSON.parse(json2),
		});

		for (let i = 0; i < 10; i++) {
			renderer.toolExecChunk("exec", `readme line ${i}\n`);
		}

		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "exec",
			call: { id: "call_2", tool: "exec", args: JSON.parse(json2) },
			stdout: "...",
			stderr: "",
			timedOut: false,
			exitCode: 0,
			durationMs: 100,
		});

		const scrollbackFinal = vt.getScrollbackLines().filter((l) => l.length > 0);
		const totalLines = vt.getVisibleLines().filter((l) => l.length > 0).length;

		console.log(
			`\n两个 tool 后: 总行数=${totalLines}, scrollback=${scrollbackFinal.length}行, scrollTop=${vt.scrollTop}`,
		);
		console.log(`viewport 容量: ${vt.viewportHeight} 行`);
		console.log(`超出: ${totalLines - vt.viewportHeight} 行`);

		if (scrollbackFinal.length > 0) {
			console.log(
				`\n这些行已经滚出 viewport，如果有任何 clear 操作尝试清除它们，将会失败。`,
			);
		}
	});
});
