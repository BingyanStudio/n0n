/**
 * LiveRegion — 可替换的终端输出区域
 *
 * 追踪已写入的行数，支持清除后重写（流式参数 → 最终摘要）。
 * 仅在 TTY 模式下支持行替换，非 TTY 时退化为追加输出。
 */

import { clearDown, cursorUp, isTTY, write } from "./ansi.ts";

export class LiveRegion {
	private lineCount = 0;

	/** 写入内容（自动追踪行数） */
	write(text: string): void {
		write(text);
		// 统计换行符数量
		for (let i = 0; i < text.length; i++) {
			if (text[i] === "\n") this.lineCount++;
		}
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
}
