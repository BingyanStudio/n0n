#!/usr/bin/env bun
/**
 * multiline-input 交互测试入口
 *
 * 用法: bun packages/multiline-input/src/test-interactive.ts
 *
 * 测试场景:
 *   1. 单行写入 — 输入一行文本，Alt+Enter 或 Ctrl+D 提交
 *   2. 多行写入 — 按 Enter 换行，输入多行后提交
 *   3. 折行处理 — 输入超过终端宽度的长文本，观察自动折行
 *   4. 历史编辑 — 用方向键移动光标，Backspace 删除，在中间插入
 *   5. 粘贴功能 — 从剪贴板粘贴多行文本（bracketed paste）
 *   6. Ctrl+Q   — 应中断当前输入（返回 null），而非退出进程
 *
 * 每次提交后会打印输入结果的详细信息，然后进入下一轮输入。
 * 输入 "exit"（单独一行）后退出测试。
 */

import { readMultilineInput } from "./reader.ts";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BG_BLUE = "\x1b[44m";
const WHITE = "\x1b[37m";

function banner(): void {
	const w = process.stderr.columns || 80;
	const line = "─".repeat(w);
	process.stderr.write(`\n${DIM}${line}${RESET}\n`);
	process.stderr.write(`${BOLD}${CYAN}  multiline-input 交互测试${RESET}\n`);
	process.stderr.write(`${DIM}${line}${RESET}\n\n`);
	process.stderr.write(`${DIM}  操作说明:${RESET}\n`);
	process.stderr.write(
		`    ${GREEN}Enter${RESET}       插入换行（多行输入）\n`,
	);
	process.stderr.write(
		`    ${GREEN}Alt+Enter${RESET}   提交输入（或 ${GREEN}Ctrl+D${RESET}）\n`,
	);
	process.stderr.write(
		`    ${GREEN}Ctrl+Q${RESET}      中断当前输入（不退出进程）\n`,
	);
	process.stderr.write(`    ${GREEN}方向键${RESET}      上下左右移动光标\n`);
	process.stderr.write(`    ${GREEN}Backspace${RESET}   删除前一个字符\n`);
	process.stderr.write(
		`    ${GREEN}粘贴${RESET}        直接 Ctrl+V 粘贴（bracketed paste）\n`,
	);
	process.stderr.write(`\n${DIM}  输入 "exit" 退出测试${RESET}\n\n`);
}

function printResult(
	result: { text: string; lineCount: number } | null,
	round: number,
): void {
	const w = process.stderr.columns || 80;
	process.stderr.write(`\n${DIM}${"─".repeat(w)}${RESET}\n`);

	if (result === null) {
		process.stderr.write(
			`${YELLOW}⚠ 第 ${round} 轮: Ctrl+Q 中断 (返回 null)${RESET}\n`,
		);
	} else {
		process.stderr.write(`${GREEN}✓ 第 ${round} 轮提交结果:${RESET}\n`);
		process.stderr.write(`  ${DIM}行数:${RESET} ${result.lineCount}\n`);
		process.stderr.write(
			`  ${DIM}字符数:${RESET} ${result.text.length} (code units)\n`,
		);
		process.stderr.write(
			`  ${DIM}字节数:${RESET} ${Buffer.byteLength(result.text, "utf8")}\n`,
		);

		// 逐行打印，标注行号
		const lines = result.text.split("\n");
		process.stderr.write(`  ${DIM}内容:${RESET}\n`);
		for (let i = 0; i < lines.length; i++) {
			const lineNum = String(i + 1).padStart(3, " ");
			const display = (lines[i] as string)
				.replace(/\t/g, "→   ")
				.replace(/ /g, "·");
			process.stderr.write(`    ${DIM}${lineNum} │${RESET} ${display}\n`);
		}

		// 检测折行（单行超过终端宽度）
		const termWidth = process.stderr.columns || 80;
		const longLines = lines.filter((l) => l.length >= termWidth);
		if (longLines.length > 0) {
			process.stderr.write(
				`  ${CYAN}ℹ 检测到 ${longLines.length} 行超过终端宽度 (${termWidth} 列)，可测试折行渲染${RESET}\n`,
			);
		}
	}

	process.stderr.write(`${DIM}${"─".repeat(w)}${RESET}\n\n`);
}

async function main(): Promise<void> {
	banner();

	let round = 0;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		round++;

		const promptLabel = `${BG_BLUE}${WHITE}${BOLD} 第 ${round} 轮 ${RESET}`;
		const hint = `${DIM}(Alt+Enter 提交, Ctrl+Q 中断)${RESET}`;

		const result = await readMultilineInput({
			prompt: promptLabel,
			hint,
		});

		printResult(result, round);

		// Ctrl+Q 返回 null 时不退出，继续下一轮
		if (result === null) {
			process.stderr.write(
				`${DIM}  → Ctrl+Q 已捕获，进程未退出，继续下一轮...${RESET}\n\n`,
			);
			continue;
		}

		// 输入 "exit" 退出
		if (result.text.trim().toLowerCase() === "exit") {
			process.stderr.write(`${DIM}Bye!${RESET}\n`);
			break;
		}
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("测试脚本异常:", err);
	process.exit(1);
});
