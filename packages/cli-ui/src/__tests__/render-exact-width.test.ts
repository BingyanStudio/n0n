/**
 * 精确宽度边界测试 — 复现 "恰好等于 cols" 的 off-by-one
 *
 * 在真实终端中（如 Windows Terminal, iTerm2, xterm），当一行文本
 * 的可见宽度恰好等于终端列数时：
 *
 * 模型A（deferred wrap / pending newline）：
 *   写完第80个字符后光标停在第80列（逻辑上的"行尾"），不自动换行。
 *   只有下一个字符或 \n 才触发真正的换行。
 *   → writeln("A".repeat(80)) 实际占1行（80字符 + \n触发换行）
 *
 * 模型B（immediate wrap）：
 *   写完第80个字符后光标自动移到下一行第1列。
 *   \n 再产生一个空行。
 *   → writeln("A".repeat(80)) 实际占2行
 *
 * 大多数现代终端使用模型A（deferred wrap），但 ceil(80/80) = 1，
 * 所以 countDisplayLines 和模型A一致。
 *
 * 但如果终端使用模型B，或者某些中间状态，就会出现 off-by-one。
 *
 * 这个测试通过构造恰好等于 cols 的行来检测。
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

describe("精确宽度边界", () => {
	afterEach(teardown);

	test("构造恰好等于 cols 的渲染行，验证 clear 行为", async () => {
		// renderToolArgs 中：`  │ ${value}`
		// 前缀 "  │ " 的可见宽度 = 4（含ANSI包裹后）
		// 值需要恰好 76 个ASCII字符使总宽度 = 80
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 用恰好76个字符的值来构造边界情况
		const exactValue = "X".repeat(76);
		const json = `{"data":"${exactValue}"}`;

		// 先完成一轮流式渲染
		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, json);
		renderer.streamEnd();

		const lines1 = vt.getVisibleLines().map((l) => stripAnsi(l));
		console.log("=== contentEnd 后屏幕 ===");
		for (let i = 0; i < lines1.length; i++) {
			const l = lines1[i];
			console.log(
				`  [${i}] len=${l.length} "${l.slice(0, 60)}${l.length > 60 ? "..." : ""}"`,
			);
		}

		// 检查值行的可见长度
		const valueLine = lines1.find((l) => l.includes("XXXX"));
		if (valueLine) {
			console.log(`\n值行可见长度: ${valueLine.length}`);
			console.log(`终端列数: 80`);
			console.log(`是否恰好等于 cols: ${valueLine.length === 80}`);
		}
	});

	test("CJK + 前缀恰好超过 cols 1列 — 最常见的 wrap 触发场景", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 构造 "  │ " (4列) + 中文内容 = 恰好 81 列（超1列）
		// 需要 (81-4)/2 = 38.5 → 38个中文 = 76列 + 4前缀 = 80 → 不够
		// 39个中文 = 78列 + 4前缀 = 82 → 超2列 → wrap
		// 38个中文 + 1个ASCII = 77列 + 4前缀 = 81 → 超1列 → wrap
		const cjkValue = "中".repeat(38) + "A"; // 38*2 + 1 = 77 + 4前缀 = 81
		const json = `{"data":"${cjkValue}"}`;

		renderer.toolCallArgStart(0, "exec");
		renderer.toolCallArgChunk(0, json);
		renderer.streamEnd();

		const lines1 = vt.getVisibleLines().map((l) => stripAnsi(l));
		console.log("=== CJK 边界 contentEnd 后 ===");
		for (let i = 0; i < lines1.length; i++) {
			const l = lines1[i];
			console.log(
				`  [${i}] len=${l.length} "${l.slice(0, 50)}${l.length > 50 ? "..." : ""}"`,
			);
		}

		// 这行应该被 wrap 成 2 行
		const valueLines = lines1.filter((l) => l.includes("中"));
		console.log(`含中文的行数: ${valueLines.length}`);
	});

	test("真实场景复现：submit 中文 summary 在 80 列终端", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 这是真实发生过的 submit 调用
		const realJson = JSON.stringify({
			type: "completed",
			summary:
				"已完成 PR #61 的清理：\n1. 关闭 PR #61，附带说明关闭原因（核心功能已被 PR #75/#76 覆盖，分支严重过时）\n2. 删除远程分支 `fix/live-region-improvements`\n3. 清理本地分支引用（`git branch -D` + `git remote prune origin`）",
			files_changed: [],
		});

		// 逐字符流式发送（最恶劣的情况）
		for (let i = 0; i < realJson.length; i++) {
			if (i === 0) renderer.toolCallArgStart(0, "submit");
			renderer.toolCallArgChunk(0, realJson[i]!);
		}
		renderer.streamEnd();

		renderer.toolExecStart({
			id: "call_1",
			tool: "submit",
			args: JSON.parse(realJson),
		});
		renderer.toolExecEnd({
			type: "tool_result" as const,
			tool: "submit",
			call: { id: "call_1", tool: "submit", args: JSON.parse(realJson) },
			cleanedResult: null,
		});

		const finalLines = vt.getVisibleLines().map((l) => stripAnsi(l));
		console.log("=== 真实 submit 最终屏幕 ===");
		for (let i = 0; i < finalLines.length; i++) {
			console.log(`  [${i}] "${finalLines[i]}"`);
		}

		// 验证没有重复头
		const headers = finalLines.filter((l) =>
			l.trimStart().startsWith("▸ submit"),
		);
		console.log(`\n▸ submit 头数量: ${headers.length}`);
		expect(headers.length).toBe(1);

		// 验证没有 streaming 残留
		const streaming = finalLines.filter((l) => l.includes("streaming"));
		expect(streaming.length).toBe(0);

		// 验证有结束行
		const resultLine = finalLines.filter((l) =>
			l.trimStart().startsWith("◂ submit"),
		);
		console.log(`◂ submit 结果行数: ${resultLine.length}`);
		expect(resultLine.length).toBe(1);
	});
});
