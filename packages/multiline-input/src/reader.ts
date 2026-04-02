/**
 * readMultilineInput — 终端多行输入读取器
 *
 * 使用 raw mode + bracketed paste mode 提供可靠的多行编辑体验。
 * 核心特性：
 * - Enter 插入换行，Alt+Enter / Ctrl+D 提交
 * - 粘贴通过 bracketed paste 100% 可靠识别（无时间阈值 hack）
 * - 中文/emoji 等宽字符光标定位正确（基于 string-width）
 * - 主动 wrap：超过终端宽度的行会被正确计算显示行数，光标定位精确
 *
 * 布局：prompt 标签在输入区域上方（不参与重绘），输入区域无前缀。
 */

import stringWidth from "string-width";
import { InputBuffer } from "./input-buffer.ts";

// ── Bracketed Paste Mode 转义序列 ──
const BP_ON = "\x1b[?2004h";
const BP_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Tab 对齐宽度（空格数） */
const TAB_WIDTH = 4;

export interface MultilineInputOptions {
	/** 提示标签，显示在输入区域上方（如 " USER "），默认无 */
	prompt?: string;
	/** 提示标签后的操作提示文字 */
	hint?: string;
	/** 输出流，默认 process.stderr */
	output?: NodeJS.WriteStream;
}

export interface MultilineInputResult {
	/** 用户提交的文本（多行用 \n 连接） */
	text: string;
	/** 文本行数 */
	lineCount: number;
}

/** 渲染状态（内部使用） */
interface DrawState {
	/** 光标所在的终端行（从渲染区域顶部算起，0-based） */
	cursorRow: number;
	/** 当前渲染区域占用的终端总行数 */
	totalRows: number;
}

/**
 * 计算行文本从 0 到 cursorCol 的终端显示宽度
 * 用于精确定位光标（中文=2列、emoji=2列、ASCII=1列）
 */
function displayCol(line: string, cursorCol: number): number {
	return stringWidth(line.slice(0, cursorCol));
}

/**
 * 计算一个逻辑行在终端上占用的实际行数
 * 考虑终端自动折行：displayWidth / termCols 向上取整，空行至少占 1 行
 */
function terminalRowsForLine(line: string, cols: number): number {
	const w = stringWidth(line);
	if (w === 0) return 1;
	return Math.ceil(w / cols);
}

/**
 * 计算光标在某逻辑行中的终端行偏移（0-based）
 * 即：光标前面的文本占了几个完整的终端行
 */
function cursorTerminalRow(line: string, cursorCol: number, cols: number): number {
	const w = displayCol(line, cursorCol);
	return Math.floor(w / cols);
}

/**
 * 计算光标在终端行中的列偏移
 * 即：光标前面文本的显示宽度 mod 终端列数
 */
function cursorTerminalCol(line: string, cursorCol: number, cols: number): number {
	const w = displayCol(line, cursorCol);
	return w % cols;
}

/**
 * 读取用户多行输入
 *
 * @returns 用户提交的文本，Ctrl+C 时返回 null
 */
export function readMultilineInput(
	options?: MultilineInputOptions,
): Promise<MultilineInputResult | null> {
	const out = options?.output ?? process.stderr;
	const stdin = process.stdin;

	return new Promise<MultilineInputResult | null>((resolve) => {
		const buf = new InputBuffer();
		let state: DrawState = { cursorRow: 0, totalRows: 0 };
		let isPasting = false;
		let pasteBuffer = "";

		// ── 写入辅助 ──
		const w = (s: string) => out.write(s);

		/** 获取终端列宽 */
		const getCols = (): number => out.columns || 80;

		// ── 显示 prompt ──
		if (options?.prompt) {
			const hint = options?.hint ?? "";
			w(`${options.prompt}${hint ? ` ${hint}` : ""}\n`);
		}

		// ── 进入 raw mode ──
		const wasRaw = stdin.isRaw;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		w(BP_ON);
		// Windows 上 Ctrl+C 即使在 raw mode 下也可能触发 SIGINT（Console Control Event），
		// 注册空 handler 阻止默认退出行为，实际中断由 \x03 字符处理
		const sigintHandler = () => {};
		process.on("SIGINT", sigintHandler);

		function cleanup(): void {
			w(BP_OFF);
			process.removeListener("SIGINT", sigintHandler);
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw ?? false);
			// 不 pause stdin — 调用方可能还需要它
		}

		function finish(result: MultilineInputResult | null): void {
			const cols = getCols();
			// 计算光标当前所在的终端行到渲染区域底部的距离
			// 先算光标之后还有多少终端行
			const cursorLine = buf.cursorLine;
			const cursorColOffset = cursorTerminalRow(buf.lines[cursorLine]!, buf.cursorCol, cols);
			const cursorLineTotal = terminalRowsForLine(buf.lines[cursorLine]!, cols);
			// 光标所在逻辑行中，光标之后还剩的终端行数
			let rowsBelow = cursorLineTotal - cursorColOffset - 1;
			// 加上光标之后所有逻辑行的终端行数
			for (let i = cursorLine + 1; i < buf.lines.length; i++) {
				rowsBelow += terminalRowsForLine(buf.lines[i]!, cols);
			}
			if (rowsBelow > 0) w(`\x1b[${rowsBelow}B`);
			w("\n");
			cleanup();
			resolve(result);
		}

		function submit(): void {
			finish({
				text: buf.getText(),
				lineCount: buf.lines.length,
			});
		}

		function abort(): void {
			finish(null);
		}

		// ── Redraw ──
		function redraw(): void {
			const cols = getCols();

			// 计算新的总终端行数
			let newTotalRows = 0;
			for (let i = 0; i < buf.lines.length; i++) {
				newTotalRows += terminalRowsForLine(buf.lines[i]!, cols);
			}

			// 计算光标所在的终端行（从渲染区域顶部算起）
			let newCursorRow = 0;
			for (let i = 0; i < buf.cursorLine; i++) {
				newCursorRow += terminalRowsForLine(buf.lines[i]!, cols);
			}
			newCursorRow += cursorTerminalRow(buf.lines[buf.cursorLine]!, buf.cursorCol, cols);

			// 1) 从当前光标位置移到渲染区域顶部
			if (state.cursorRow > 0) w(`\x1b[${state.cursorRow}A`);
			w("\r");

			// 2) 新增终端行时先 scroll 终端，确保有足够空间
			if (newTotalRows > state.totalRows) {
				const extra = newTotalRows - state.totalRows;
				const toOldBottom = Math.max(0, state.totalRows - 1);
				if (toOldBottom > 0) w(`\x1b[${toOldBottom}B`);
				for (let i = 0; i < extra; i++) w("\n");
				const totalUp = newTotalRows - 1;
				if (totalUp > 0) w(`\x1b[${totalUp}A`);
				w("\r");
			}

			// 3) clearDown + 重绘所有内容
			w("\x1b[J");
			for (let i = 0; i < buf.lines.length; i++) {
				if (i > 0) w("\n");
				w(buf.lines[i]!);
			}

			// 4) 从渲染区域底部移到光标所在的终端行
			const up = newTotalRows - 1 - newCursorRow;
			if (up > 0) w(`\x1b[${up}A`);
			w("\r");
			const dc = cursorTerminalCol(buf.lines[buf.cursorLine]!, buf.cursorCol, cols);
			if (dc > 0) w(`\x1b[${dc}C`);

			state = { cursorRow: newCursorRow, totalRows: newTotalRows };
		}

		// 初始 redraw（空行）
		redraw();

		// ── 输入处理 ──
		function onData(data: string): void {
			// ── Bracketed Paste ──
			if (data.includes(PASTE_START)) {
				isPasting = true;
				pasteBuffer = "";
				const rest = data.split(PASTE_START).slice(1).join(PASTE_START);
				if (rest.includes(PASTE_END)) {
					buf.insertText(rest.split(PASTE_END)[0] ?? "");
					isPasting = false;
					redraw();
					return;
				}
				pasteBuffer += rest;
				return;
			}
			if (isPasting) {
				if (data.includes(PASTE_END)) {
					pasteBuffer += data.split(PASTE_END)[0] ?? "";
					buf.insertText(pasteBuffer);
					isPasting = false;
					pasteBuffer = "";
					redraw();
					return;
				}
				pasteBuffer += data;
				return;
			}

			// ── 逐字符处理 ──
			let i = 0;
			let needsRedraw = false;

			while (i < data.length) {
				const code = data.charCodeAt(i);

				// Ctrl+C → 中止
				if (code === 3) {
					abort();
					return;
				}

				// Ctrl+D → 提交
				if (code === 4) {
					submit();
					return;
				}

				// ESC 序列
				if (code === 27) {
					const next = data[i + 1];
					// Alt+Enter = ESC CR → 提交
					if (next === "\r") {
						submit();
						return;
					}
					// 方向键 ESC [ A/B/C/D
					if (next === "[") {
						const arrow = data[i + 2];
						if (arrow === "A") buf.moveUp();
						else if (arrow === "B") buf.moveDown();
						else if (arrow === "C") buf.moveRight();
						else if (arrow === "D") buf.moveLeft();
						i += 3;
						needsRedraw = true;
						continue;
					}
					i++;
					continue;
				}

				// Enter → 换行
				if (code === 13) {
					buf.insertNewline();
					i++;
					needsRedraw = true;
					continue;
				}

				// Backspace
				if (code === 127 || code === 8) {
					buf.backspace();
					i++;
					needsRedraw = true;
					continue;
				}

				// Tab → 插入对齐到 tab stop 的空格（避免 \t 的显示宽度不可预测）
				if (code === 9) {
					const dc = displayCol(buf.lines[buf.cursorLine]!, buf.cursorCol);
					const spaces = TAB_WIDTH - (dc % TAB_WIDTH);
					buf.insertText(" ".repeat(spaces));
					i++;
					needsRedraw = true;
					continue;
				}

				// 忽略其他控制字符
				if (code < 32) {
					i++;
					continue;
				}

				// 普通字符（可能是多 code unit）
				// 检查是否是 high surrogate
				if (code >= 0xd800 && code <= 0xdbff && i + 1 < data.length) {
					buf.insertText(data.slice(i, i + 2));
					i += 2;
				} else {
					buf.insertText(data[i]!);
					i++;
				}
				needsRedraw = true;
			}

			if (needsRedraw) redraw();
		}

		stdin.on("data", onData);
	});
}
