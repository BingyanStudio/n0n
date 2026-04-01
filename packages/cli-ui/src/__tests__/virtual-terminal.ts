/**
 * VirtualTerminal — ANSI 虚拟终端状态机
 *
 * 模拟真实终端的屏幕缓冲区，解释 ANSI 转义序列（光标移动、清除等），
 * 正确处理文本自动换行（包括 CJK 全角字符占 2 列）。
 *
 * 用途：让 RichRenderer 的输出写入虚拟屏幕，断言最终画面是否正确，
 * 而不是简单地检查输出字符串中包含某些文本。
 */

import stringWidth from "string-width";

/** 单个字符单元（一个终端格子） */
interface Cell {
	char: string; // 可见字符，空格为 " "
	/** 全角字符的右半部分标记 */
	isWideRight: boolean;
}

function emptyCell(): Cell {
	return { char: " ", isWideRight: false };
}

/**
 * 判断码点是否为全角/CJK（终端占 2 列）
 * 与 ansi.ts 中的 string-width 保持一致
 */
function charWidth(ch: string): number {
	// 使用与生产代码相同的 string-width 来保证一致性
	return stringWidth(ch);
}

export class VirtualTerminal {
	readonly cols: number;
	readonly rows: number;
	readonly viewportHeight: number;
	/** 屏幕缓冲区 [row][col] */
	private buffer: Cell[][];
	/** 光标位置 */
	cursorRow = 0;
	cursorCol = 0;
	/** 已滚出可视区域顶部的行数 */
	scrollTop = 0;
	/** 所有写入的原始数据（用于调试） */
	rawLog: string[] = [];

	constructor(cols = 80, rows = 200, viewportHeight?: number) {
		this.cols = cols;
		this.rows = rows;
		this.viewportHeight = viewportHeight ?? rows;
		this.buffer = [];
		for (let r = 0; r < rows; r++) {
			this.buffer.push(this.newRow());
		}
	}

	private newRow(): Cell[] {
		return Array.from({ length: this.cols }, () => emptyCell());
	}

	/** 确保行存在 */
	private ensureRow(r: number): void {
		while (this.buffer.length <= r) {
			this.buffer.push(this.newRow());
		}
	}

	/** 处理一段原始输出（含 ANSI 转义） */
	feed(data: string): void {
		this.rawLog.push(data);
		let i = 0;
		while (i < data.length) {
			if (data[i] === "\x1b" && data[i + 1] === "[") {
				// CSI 序列: \x1b[ ... 终止字符
				const csiStart = i + 2;
				let csiEnd = csiStart;
				while (csiEnd < data.length && !/[A-Za-z~@]/.test(data[csiEnd]!)) {
					csiEnd++;
				}
				if (csiEnd < data.length) {
					const params = data.slice(csiStart, csiEnd);
					const cmd = data[csiEnd]!;
					this.handleCSI(params, cmd);
					i = csiEnd + 1;
				} else {
					i++;
				}
			} else if (data[i] === "\n") {
				this.newline();
				i++;
			} else if (data[i] === "\r") {
				this.cursorCol = 0;
				i++;
			} else {
				// 普通可见字符
				this.putChar(data[i]!);
				i++;
			}
		}
	}

	/** 处理 CSI 序列 */
	private handleCSI(params: string, cmd: string): void {
		const n = params ? Number.parseInt(params, 10) || 0 : 0;
		switch (cmd) {
			case "A": // Cursor Up
				this.cursorRow = Math.max(this.scrollTop, this.cursorRow - (n || 1));
				break;
			case "B": // Cursor Down
				this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (n || 1));
				break;
			case "G": // Cursor Horizontal Absolute
				this.cursorCol = Math.max(0, (n || 1) - 1);
				if (params === "0" || params === "") this.cursorCol = 0;
				break;
			case "J": // Erase in Display
				this.eraseDisplay(n);
				break;
			case "K": // Erase in Line
				this.eraseLine(n);
				break;
			case "m": // SGR（颜色/样式）— 忽略，不影响位置
				break;
			case "h": // 私有模式设置（如 ?25h 显示光标）— 忽略
			case "l": // 私有模式重置（如 ?25l 隐藏光标）— 忽略
				break;
			default:
				// 未知 CSI 指令 — 忽略
				break;
		}
	}

	/** 写入一个可见字符 */
	private putChar(ch: string): void {
		const w = charWidth(ch);
		if (w === 0) return; // 零宽字符（组合字符等）

		// 如果当前行放不下这个字符，自动换行
		if (this.cursorCol + w > this.cols) {
			this.newline();
		}

		this.ensureRow(this.cursorRow);
		const row = this.buffer[this.cursorRow]!;

		if (w === 2) {
			// 全角字符：占两格
			row[this.cursorCol] = { char: ch, isWideRight: false };
			if (this.cursorCol + 1 < this.cols) {
				row[this.cursorCol + 1] = { char: "", isWideRight: true };
			}
			this.cursorCol += 2;
		} else {
			row[this.cursorCol] = { char: ch, isWideRight: false };
			this.cursorCol += 1;
		}

		// 光标到达行尾时的处理：
		// 真实终端在恰好填满时通常进入"待定换行"状态(pending wrap)
		// 下一个字符才真正换行。这里简化处理：cursorCol 可以等于 cols，
		// 下次 putChar 时再检查换行。
	}

	private newline(): void {
		this.cursorCol = 0;
		this.cursorRow++;
		this.ensureRow(this.cursorRow);
		// 当光标超出可视区域底部时，滚动
		while (this.cursorRow >= this.scrollTop + this.viewportHeight) {
			this.scrollTop++;
		}
	}

	/** Erase in Display: 0=从光标到末尾, 1=从开头到光标, 2=全屏 */
	private eraseDisplay(mode: number): void {
		if (mode === 0 || mode === undefined) {
			// 清除从光标到屏幕末尾
			// 先清除当前行光标之后的部分
			this.ensureRow(this.cursorRow);
			for (let c = this.cursorCol; c < this.cols; c++) {
				this.buffer[this.cursorRow]![c] = emptyCell();
			}
			// 清除光标下方所有行
			for (let r = this.cursorRow + 1; r < this.buffer.length; r++) {
				this.buffer[r] = this.newRow();
			}
		}
	}

	/** Erase in Line: 0=光标到行尾, 1=行首到光标, 2=整行 */
	private eraseLine(mode: number): void {
		this.ensureRow(this.cursorRow);
		const row = this.buffer[this.cursorRow]!;
		if (mode === 2) {
			for (let c = 0; c < this.cols; c++) row[c] = emptyCell();
		} else if (mode === 0) {
			for (let c = this.cursorCol; c < this.cols; c++) row[c] = emptyCell();
		} else if (mode === 1) {
			for (let c = 0; c <= this.cursorCol; c++) row[c] = emptyCell();
		}
	}

	/** 获取某行的可见文本（去除尾部空格） */
	getLine(row: number): string {
		if (row >= this.buffer.length) return "";
		// biome-ignore lint/style/noNonNullAssertion: bounds checked above
		return this.buffer[row]!.filter((c) => !c.isWideRight)
			.map((c) => c.char)
			.join("")
			.replace(/\s+$/, "");
	}

	/** 获取当前 viewport 中的可见行 */
	getViewportLines(): string[] {
		const lines: string[] = [];
		for (
			let r = this.scrollTop;
			r < this.scrollTop + this.viewportHeight;
			r++
		) {
			lines.push(this.getLine(r));
		}
		return lines;
	}

	/** 获取已滚出可视区域的行（scrollback buffer） */
	getScrollbackLines(): string[] {
		const lines: string[] = [];
		for (let r = 0; r < this.scrollTop; r++) {
			lines.push(this.getLine(r));
		}
		return lines;
	}

	/** 获取屏幕上所有非空行 */
	getVisibleLines(): string[] {
		const lines: string[] = [];
		// 找到最后一个非空行
		let lastNonEmpty = -1;
		for (let r = 0; r < this.buffer.length; r++) {
			if (this.getLine(r).length > 0) lastNonEmpty = r;
		}
		for (let r = 0; r <= lastNonEmpty; r++) {
			lines.push(this.getLine(r));
		}
		return lines;
	}

	/** 将屏幕内容输出为字符串（调试用） */
	dump(): string {
		const lines = this.getVisibleLines();
		return lines
			.map((l, i) => {
				const cursor =
					i === this.cursorRow ? `←cursor(col=${this.cursorCol})` : "";
				return `${String(i).padStart(3)}│${l}${cursor}`;
			})
			.join("\n");
	}
}
