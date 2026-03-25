/**
 * LiveRegion — 可替换的终端输出区域
 *
 * 追踪已写入的行数，支持清除后重写（流式参数 → 最终摘要）。
 * 仅在 TTY 模式下支持行替换，非 TTY 时退化为追加输出。
 *
 * 行计数考虑终端自动换行(wrap)：当单行可见宽度超过终端列宽时，
 * 实际占用的终端行数 = ceil(visibleWidth / columns)。
 */

import {
	clearDown,
	cursorUp,
	isTTY,
	terminalColumns,
	visibleWidth,
	write,
} from "./ansi.ts";

export class LiveRegion {
	private lineCount = 0;

	/** 写入内容（自动追踪行数，考虑终端 wrap） */
	write(text: string): void {
		write(text);
		this.lineCount += this.countDisplayLines(text);
	}

	/** 写入一行（含换行） */
	writeln(text = ""): void {
		this.write(`${text}\n`);
	}

	/** 清除已写入的所有行，光标回到起始位置 */
	clear(): void {
		if (!isTTY || this.lineCount === 0) {
			this.lineCount = 0;
			return;
		}
		// 上移到区域起始位置，然后清除到屏幕末尾
		// 使用 clearDown 而非逐行清除，避免行数增长时残留未清除的行
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

	/**
	 * 计算文本在终端中实际占用的显示行数。
	 * 每个 \n 产生一个换行，同时每行的可见宽度超过终端列宽时会自动 wrap。
	 */
	private countDisplayLines(text: string): number {
		const cols = terminalColumns();
		let displayLines = 0;

		const lines = text.split("\n");
		// text.split("\n") 产生 N 段，其中有 N-1 个换行符
		// 每个换行符对应一个终端行结束，最后一段如果非空则正在当前行继续
		for (let i = 0; i < lines.length; i++) {
			const isLastSegment = i === lines.length - 1;

			if (!isLastSegment) {
				// 此段以 \n 结尾 — 至少占 1 行
				const w = visibleWidth(lines[i] ?? "");
				if (w === 0) {
					displayLines += 1; // 空行
				} else {
					displayLines += Math.ceil(w / cols);
				}
			}
			// 最后一段（\n 之后的尾部）不产生新行 — 它还在同一行上
			// 但如果它很长也会 wrap，不过 LiveRegion 主要通过 writeln 使用，
			// 最后一段通常为空字符串（因为 writeln 以 \n 结尾）
		}

		return displayLines;
	}
}
