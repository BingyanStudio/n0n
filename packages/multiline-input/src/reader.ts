// biome-ignore-all lint/style/noNonNullAssertion: internal array/string access with bounds checks
/**
 * readMultilineInput — 终端多行输入读取器
 *
 * raw mode + bracketed paste mode 多行编辑。
 * 支持 connectStdin 模式：调用方统一管理 stdin 生命周期，避免 listener 累积。
 */

import stringWidth from "string-width";
import { InputBuffer } from "./input-buffer.ts";

const BP_ON = "\x1b[?2004h";
const BP_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const TAB_WIDTH = 4;

export interface MultilineInputOptions {
	prompt?: string;
	hint?: string;
	output?: NodeJS.WriteStream;
	/**
	 * 外部 stdin 数据源注入点。
	 *
	 * 当提供此选项时，readMultilineInput 不自行管理 stdin
	 * （不设置 raw mode、不添加 data listener、不修改 encoding），
	 * 而是通过此函数注册数据处理器，由调用方统一管理 stdin 生命周期。
	 *
	 * @param handler 接收 stdin 数据的处理函数
	 * @returns 清理函数，readMultilineInput 结束时调用
	 */
	connectStdin?: (handler: (data: string) => void) => () => void;
}

export interface MultilineInputResult {
	text: string;
	lineCount: number;
}

interface DrawState {
	cursorRow: number;
	totalRows: number;
}

function displayCol(line: string, cursorCol: number): number {
	return stringWidth(line.slice(0, cursorCol));
}

function terminalRowsForLine(line: string, cols: number): number {
	const w = stringWidth(line);
	if (w === 0) return 1;
	return Math.ceil(w / cols);
}

function cursorTerminalRow(
	line: string,
	cursorCol: number,
	cols: number,
): number {
	const w = displayCol(line, cursorCol);
	return Math.floor(w / cols);
}

function cursorTerminalCol(
	line: string,
	cursorCol: number,
	cols: number,
): number {
	const w = displayCol(line, cursorCol);
	return w % cols;
}

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

		const w = (s: string) => out.write(s);
		const getCols = (): number => out.columns || 80;

		if (options?.prompt) {
			const hint = options?.hint ?? "";
			w(`${options.prompt}${hint ? ` ${hint}` : ""}\n`);
		}

		w(BP_ON);

		let disconnectStdin: (() => void) | null = null;

		function cleanup(): void {
			w(BP_OFF);
			disconnectStdin?.();
			disconnectStdin = null;
		}

		function finish(result: MultilineInputResult | null): void {
			const cols = getCols();
			const cursorLine = buf.cursorLine;
			const cursorColOffset = cursorTerminalRow(
				buf.lines[cursorLine]!,
				buf.cursorCol,
				cols,
			);
			const cursorLineTotal = terminalRowsForLine(buf.lines[cursorLine]!, cols);
			let rowsBelow = cursorLineTotal - cursorColOffset - 1;
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

		function redraw(): void {
			const cols = getCols();

			let newTotalRows = 0;
			for (let i = 0; i < buf.lines.length; i++) {
				newTotalRows += terminalRowsForLine(buf.lines[i]!, cols);
			}

			let newCursorRow = 0;
			for (let i = 0; i < buf.cursorLine; i++) {
				newCursorRow += terminalRowsForLine(buf.lines[i]!, cols);
			}
			newCursorRow += cursorTerminalRow(
				buf.lines[buf.cursorLine]!,
				buf.cursorCol,
				cols,
			);

			if (state.cursorRow > 0) w(`\x1b[${state.cursorRow}A`);
			w("\r");

			if (newTotalRows > state.totalRows) {
				const extra = newTotalRows - state.totalRows;
				const toOldBottom = Math.max(0, state.totalRows - 1);
				if (toOldBottom > 0) w(`\x1b[${toOldBottom}B`);
				for (let i = 0; i < extra; i++) w("\n");
				const totalUp = newTotalRows - 1;
				if (totalUp > 0) w(`\x1b[${totalUp}A`);
				w("\r");
			}

			w("\x1b[J");
			for (let i = 0; i < buf.lines.length; i++) {
				if (i > 0) w("\n");
				w(buf.lines[i]!);
			}

			const up = newTotalRows - 1 - newCursorRow;
			if (up > 0) w(`\x1b[${up}A`);
			w("\r");
			const dc = cursorTerminalCol(
				buf.lines[buf.cursorLine]!,
				buf.cursorCol,
				cols,
			);
			if (dc > 0) w(`\x1b[${dc}C`);

			state = { cursorRow: newCursorRow, totalRows: newTotalRows };
		}

		redraw();

		function onData(data: string): void {
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

			let i = 0;
			let needsRedraw = false;

			while (i < data.length) {
				const code = data.charCodeAt(i);

				if (code === 3) {
					abort();
					return;
				}
				if (code === 4) {
					submit();
					return;
				}

				if (code === 27) {
					const next = data[i + 1];
					if (next === "\r") {
						submit();
						return;
					}
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

				if (code === 13) {
					buf.insertNewline();
					i++;
					needsRedraw = true;
					continue;
				}

				if (code === 127 || code === 8) {
					buf.backspace();
					i++;
					needsRedraw = true;
					continue;
				}

				if (code === 9) {
					const dc = displayCol(buf.lines[buf.cursorLine]!, buf.cursorCol);
					const spaces = TAB_WIDTH - (dc % TAB_WIDTH);
					buf.insertText(" ".repeat(spaces));
					i++;
					needsRedraw = true;
					continue;
				}

				if (code < 32) {
					i++;
					continue;
				}

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

		if (options?.connectStdin) {
			disconnectStdin = options.connectStdin(onData);
		} else {
			const wasRaw = stdin.isRaw;
			stdin.setRawMode(true);
			stdin.resume();
			stdin.setEncoding("utf8");
			stdin.on("data", onData);
			disconnectStdin = () => {
				stdin.removeListener("data", onData);
				stdin.setRawMode(wasRaw ?? false);
				// 不 pause stdin — 调用方可能还需要它
			};
		}
	});
}
