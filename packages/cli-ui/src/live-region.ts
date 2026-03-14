/**
 * LiveRegion — 可替换的终端输出区域
 *
 * 追踪已写入的行数，支持清除后重写（流式参数 → 最终摘要）。
 * 仅在 TTY 模式下支持行替换，非 TTY 时退化为追加输出。
 *
 * 改进：基于终端宽度计算实际显示行数（含自动换行），
 * 而非仅统计换行符数量，解决长行被终端自动折行后光标错位的问题。
 */

import { clearLine, cursorUp, getTerminalWidth, isTTY, write } from "./ansi.ts";
import { stripAnsi } from "./strip-ansi.ts";

/**
 * 计算一段文本在终端中实际占用的显示行数。
 *
 * 考虑：
 * - 显式换行符 `\n` 产生新行
 * - 单行内容超过终端宽度时的自动折行
 * - ANSI 转义序列不占显示宽度
 */
export function computeDisplayLines(text: string, termWidth: number): number {
	if (termWidth <= 0) return 0;
	const lines = text.split("\n");
	let total = 0;
	for (const line of lines) {
		const visible = stripAnsi(line);
		// 空行占 1 行，非空行按终端宽度折行
		total += visible.length === 0 ? 1 : Math.ceil(visible.length / termWidth);
	}
	return total;
}

export class LiveRegion {
	/** 实际显示行数（含终端自动折行） */
	private displayLines = 0;
	/** 是否暂停输出（输入锁定期间） */
	private paused = false;
	/** 暂停期间缓冲的内容 */
	private pauseBuffer: string[] = [];

	/** 写入内容（自动追踪实际显示行数） */
	write(text: string): void {
		if (this.paused) {
			this.pauseBuffer.push(text);
			return;
		}
		write(text);
		this.displayLines += computeDisplayLines(text, getTerminalWidth());
		// 最后一段如果没有以 \n 结尾，不算完整行结束，
		// 但 cursorUp 是按行移动的，这里保守计算（下次 write 会在同一行继续）
		if (text.length > 0 && !text.endsWith("\n")) {
			// 最后一个不完整行已经被 computeDisplayLines 计入，
			// 但它还没有换行，所以减去 1（它还在当前行）
			this.displayLines -= 1;
		}
	}

	/** 写入一行（含换行） */
	writeln(text = ""): void {
		this.write(`${text}\n`);
	}

	/** 清除已写入的所有行，光标回到起始位置 */
	clear(): void {
		if (!isTTY || this.displayLines === 0) {
			this.displayLines = 0;
			return;
		}
		// 上移 displayLines 行，逐行清除
		cursorUp(this.displayLines);
		for (let i = 0; i < this.displayLines; i++) {
			clearLine();
			if (i < this.displayLines - 1) write("\n");
		}
		// 回到第一行
		if (this.displayLines > 1) {
			cursorUp(this.displayLines - 1);
		}
		clearLine();
		this.displayLines = 0;
	}

	/** 清除后写入替换内容 */
	replace(text: string): void {
		this.clear();
		this.write(text);
	}

	/** 重置行计数（不清屏，用于逻辑重置） */
	reset(): void {
		this.displayLines = 0;
		this.pauseBuffer = [];
	}

	/** 暂停输出（用户输入时调用） */
	pause(): void {
		this.paused = true;
	}

	/** 恢复输出，刷出暂停期间缓冲的内容 */
	resume(): void {
		this.paused = false;
		if (this.pauseBuffer.length > 0) {
			const buffered = this.pauseBuffer.join("");
			this.pauseBuffer = [];
			this.write(buffered);
		}
	}

	/** 当前是否暂停 */
	get isPaused(): boolean {
		return this.paused;
	}
}
