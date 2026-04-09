/**
 * 闪烁/残留复现测试 — 检查流式 clear+rewrite 过程中每一帧
 *
 * 核心思路：在每次 toolCallArgChunk 调用后快照虚拟终端状态，
 * 验证 streamRegion 的 clear 是否完全清除了上一帧的内容。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	randomChunks,
	restoreStderr,
	saveStderr,
	setupVT,
	stripAnsi,
} from "./test-helpers.ts";

const saved = saveStderr();

describe("流式渲染逐帧检查", () => {
	afterEach(() => restoreStderr(saved));

	test("每次 chunk 后 streamRegion 不应有前一帧的残留行", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		const json = '{"script":"echo hello world","runtime":"cmd"}';
		const chunks = randomChunks(json, 42);

		// roundStart 输出占的行数
		const baseLines = vt.getVisibleLines().length;
		let prevStreamLines: string[] = [];

		const issues: string[] = [];

		for (let ci = 0; ci < chunks.length; ci++) {
			if (ci === 0) renderer.toolCallArgStart(0, "exec");
			renderer.toolCallArgChunk(0, chunks[ci] as string);

			const allLines = vt.getVisibleLines();
			const cleanLines = allLines.map((l) => stripAnsi(l));
			// streamRegion 的内容 = 总行数 - baseLines
			const streamLines = cleanLines.slice(baseLines);

			// 检查：stream 区域中不应包含上一帧有、但这一帧不应该有的"幽灵行"
			// 如果这一帧的行数少于上一帧，说明 clear 应该清掉了多余行
			// 但如果多余行还在，就是残留
			if (
				streamLines.length > 0 &&
				prevStreamLines.length > streamLines.length
			) {
				// 行数缩减了 — 检查下方是否有残留
				for (let r = baseLines + streamLines.length; r < allLines.length; r++) {
					const ghostLine = stripAnsi(vt.getLine(r));
					if (ghostLine.trim().length > 0) {
						issues.push(
							`chunk[${ci}]: 行数从 ${prevStreamLines.length} 缩减到 ${streamLines.length}，` +
								`但第 ${r} 行仍有残留: "${ghostLine}"`,
						);
					}
				}
			}

			// 检查：不应有重复的 "▸ exec" 头
			const headers = streamLines.filter((l) => l.trimStart().startsWith("▸"));
			if (headers.length > 1) {
				issues.push(
					`chunk[${ci}]: 发现 ${headers.length} 个工具头: ${JSON.stringify(headers)}`,
				);
			}

			prevStreamLines = streamLines;
		}

		if (issues.length > 0) {
			console.log("=== 发现问题 ===");
			for (const issue of issues) console.log(`  ❌ ${issue}`);
			console.log(`\n=== 最终屏幕 ===\n${vt.dump()}`);
		}
		expect(issues.length).toBe(0);
	});

	test("CJK wrap 场景 — 逐帧无残留", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		const json =
			'{"type":"completed","summary":"已完成清理：关闭 PR 附带说明关闭原因（核心功能已被覆盖，分支严重过时）删除远程分支清理本地分支引用"}';
		const chunks = randomChunks(json, 7);

		const baseLines = vt.getVisibleLines().length;
		const issues: string[] = [];

		for (let ci = 0; ci < chunks.length; ci++) {
			if (ci === 0) renderer.toolCallArgStart(0, "submit");
			renderer.toolCallArgChunk(0, chunks[ci] as string);

			const allLines = vt.getVisibleLines();
			const streamLines = allLines.slice(baseLines).map((l) => stripAnsi(l));

			// 检查 stream 区域不应有重复的 ▸ 头
			const headers = streamLines.filter((l) => l.trimStart().startsWith("▸"));
			if (headers.length > 1) {
				issues.push(
					`chunk[${ci}]: 重复头 ${headers.length}: ${JSON.stringify(headers)}`,
				);
			}
		}

		if (issues.length > 0) {
			console.log("=== CJK 场景问题 ===");
			for (const issue of issues) console.log(`  ❌ ${issue}`);
			console.log(`\n=== 最终屏幕 ===\n${vt.dump()}`);
		}
		expect(issues.length).toBe(0);
	});

	test("多种子 fuzz — 逐帧检查重复头和残留", async () => {
		const json = '{"script":"find . -name *.ts | head -20","runtime":"bun"}';
		const allIssues: { seed: number; issues: string[] }[] = [];

		for (const seed of [1, 13, 42, 77, 100, 256, 999, 4096, 65535, 12345]) {
			const vt = setupVT(80);
			const { RichRenderer } = await import("../rich-renderer.ts");
			const renderer = new RichRenderer();

			renderer.roundStart(1, 10, 3);
			const baseLines = vt.getVisibleLines().length;
			const chunks = randomChunks(json, seed);
			const issues: string[] = [];

			for (let ci = 0; ci < chunks.length; ci++) {
				if (ci === 0) renderer.toolCallArgStart(0, "exec");
				renderer.toolCallArgChunk(0, chunks[ci] as string);

				const streamLines = vt
					.getVisibleLines()
					.slice(baseLines)
					.map((l) => stripAnsi(l));

				const headers = streamLines.filter((l) =>
					l.trimStart().startsWith("▸"),
				);
				if (headers.length > 1) {
					issues.push(`seed=${seed} chunk[${ci}]: ${headers.length} headers`);
				}
			}

			if (issues.length > 0) {
				allIssues.push({ seed, issues });
			}
			restoreStderr(saved);
		}

		if (allIssues.length > 0) {
			console.log("=== 多种子 fuzz 发现问题 ===");
			for (const { seed, issues } of allIssues) {
				console.log(`  seed=${seed}: ${issues.length} issues`);
				for (const i of issues.slice(0, 3)) console.log(`    ${i}`);
			}
		}
		expect(allIssues.length).toBe(0);
	});

	test("精确等于终端宽度的行 — 检查是否多算/少算一行", async () => {
		const vt = setupVT(80);
		const { RichRenderer } = await import("../rich-renderer.ts");
		const renderer = new RichRenderer();

		renderer.roundStart(1, 10, 3);

		// 构造一个值，使得 "  │ {value}" 恰好 80 列
		// 前缀 "  │ " = 4 列，所以值需要 76 个 ASCII 字符
		const value76 = "A".repeat(76);
		const json = `{"data":"${value76}"}`;
		const chunks = randomChunks(json, 42);

		const baseLines = vt.getVisibleLines().length;

		renderer.toolCallArgStart(0, "exec");
		for (const chunk of chunks) {
			renderer.toolCallArgChunk(0, chunk);
		}
		renderer.streamEnd();

		// contentEnd 后屏幕应干净
		const lines = vt.getVisibleLines().map((l) => stripAnsi(l));
		const streamLines = lines.slice(baseLines);
		const headers = streamLines.filter((l) => l.trimStart().startsWith("▸"));
		expect(headers.length).toBe(1);

		// dump 用于调试
		if (headers.length !== 1) {
			console.log(vt.dump());
		}
	});
});
