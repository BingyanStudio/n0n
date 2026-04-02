/**
 * InputBuffer — 多行文本编辑缓冲区（纯逻辑，无 IO）
 *
 * 维护行数组 + 光标位置，提供插入、删除、移动等操作。
 * 光标位置 (cursorCol) 使用 code unit offset（与 String.slice 一致）。
 * 移动/删除操作正确处理 surrogate pair（emoji 等 BMP 外字符）。
 */

/** 检测 code unit 是否为 high surrogate */
function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** 检测 code unit 是否为 low surrogate */
function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** 从当前位置向左跨越一个完整字符的 code unit 数 */
function charStepLeft(line: string, col: number): number {
	if (col <= 0) return 0;
	if (col >= 2 && isLowSurrogate(line.charCodeAt(col - 1))) return 2;
	return 1;
}

/** 从当前位置向右跨越一个完整字符的 code unit 数 */
function charStepRight(line: string, col: number): number {
	if (col >= line.length) return 0;
	if (isHighSurrogate(line.charCodeAt(col)) && col + 1 < line.length) return 2;
	return 1;
}

export class InputBuffer {
	lines: string[] = [""];
	cursorLine = 0;
	cursorCol = 0;

	/** 插入文本（可含换行，用于粘贴） */
	insertText(text: string): void {
		for (const ch of text) {
			if (ch === "\n" || ch === "\r") {
				this.insertNewline();
			} else {
				const line = this.lines[this.cursorLine]!;
				this.lines[this.cursorLine] =
					line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
				this.cursorCol += ch.length; // ch.length 可能为 2（surrogate pair）
			}
		}
	}

	insertNewline(): void {
		const line = this.lines[this.cursorLine]!;
		this.lines[this.cursorLine] = line.slice(0, this.cursorCol);
		this.lines.splice(this.cursorLine + 1, 0, line.slice(this.cursorCol));
		this.cursorLine++;
		this.cursorCol = 0;
	}

	backspace(): void {
		if (this.cursorCol > 0) {
			const line = this.lines[this.cursorLine]!;
			const step = charStepLeft(line, this.cursorCol);
			this.lines[this.cursorLine] =
				line.slice(0, this.cursorCol - step) + line.slice(this.cursorCol);
			this.cursorCol -= step;
		} else if (this.cursorLine > 0) {
			const cur = this.lines[this.cursorLine]!;
			const prev = this.lines[this.cursorLine - 1]!;
			this.cursorCol = prev.length;
			this.lines[this.cursorLine - 1] = prev + cur;
			this.lines.splice(this.cursorLine, 1);
			this.cursorLine--;
		}
	}

	moveUp(): void {
		if (this.cursorLine > 0) {
			this.cursorLine--;
			this.cursorCol = Math.min(
				this.cursorCol,
				this.lines[this.cursorLine]!.length,
			);
		}
	}

	moveDown(): void {
		if (this.cursorLine < this.lines.length - 1) {
			this.cursorLine++;
			this.cursorCol = Math.min(
				this.cursorCol,
				this.lines[this.cursorLine]!.length,
			);
		}
	}

	moveLeft(): void {
		if (this.cursorCol > 0) {
			this.cursorCol -= charStepLeft(
				this.lines[this.cursorLine]!,
				this.cursorCol,
			);
		}
	}

	moveRight(): void {
		const line = this.lines[this.cursorLine]!;
		if (this.cursorCol < line.length) {
			this.cursorCol += charStepRight(line, this.cursorCol);
		}
	}

	getText(): string {
		return this.lines.join("\n");
	}

	reset(): void {
		this.lines = [""];
		this.cursorLine = 0;
		this.cursorCol = 0;
	}
}
