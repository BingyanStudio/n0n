/**
 * LiveRegion — 可替换的终端输出区域
 *
 * 追踪已写入的行数，支持清除后重写（流式参数 → 最终摘要）。
 * 仅在 TTY 模式下支持行替换，非 TTY 时退化为追加输出。
 *
 * 行计数策略：主动 wrap
 * 写入前先用 wrap-ansi 按终端列宽主动折行，再输出折行后的文本。
 * 行数 = 折行后文本中的 \n 数量，100% 精确，无需事后估算。
 */

import wrapAnsi from "wrap-ansi";
import { clearDown, cursorUp, isTTY, terminalColumns, write } from "./ansi.ts";

/** wrap-ansi 选项：硬折行，不裁剪空格，不做单词级换行 */
const WRAP_OPTIONS = { trim: false, hard: true, wordWrap: false } as const;

export class LiveRegion {
	private lineCount = 0;

	/** 写入一行（含换行）— LiveRegion 的主要 API */
	writeln(text = ""): void {
		const cols = terminalColumns();
		// 主动 wrap：将超宽内容折成多个终端行
		const wrapped = wrapAnsi(text, cols, WRAP_OPTIONS);
		const output = `${wrapped}\n`;
		write(output);
		// 精确计数：折行后的 \n 数量就是实际占用的终端行数
		this.lineCount += countNewlines(output);
	}

	/**
	 * 写入内容（不自动换行）
	 *
	 * 注意：对不以 \n 结尾的文本，行数计算可能不完全精确
	 * （当前行的剩余宽度未被追踪）。建议优先使用 writeln()。
	 */
	write(text: string): void {
		const cols = terminalColumns();
		const wrapped = wrapAnsi(text, cols, WRAP_OPTIONS);
		write(wrapped);
		this.lineCount += countNewlines(wrapped);
	}

	/** 清除已写入的所有行，光标回到起始位置 */
	clear(): void {
		if (!isTTY || this.lineCount === 0) {
			this.lineCount = 0;
			return;
		}
		cursorUp(this.lineCount);
		clearDown();
		this.lineCount = 0;
	}

	/** 清除后写入替换内容 */
	replace(text: string): void {
		this.clear();
		this.write(text);
	}

	/** 重置行计数（不清屏，用于逻辑重置） */
	reset(): void {
		this.lineCount = 0;
	}
}

/** 计算字符串中 \n 的数量 */
function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") count++;
	}
	return count;
}
