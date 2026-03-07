/**
 * ANSI 工具层 — 颜色标签 + 光标控制
 *
 * 颜色基于 picocolors（自动处理 NO_COLOR / 管道检测）。
 * 光标控制为 raw ANSI escape sequences。
 */

import pc from "picocolors";

const out = process.stderr;

// ── 角色标签 ──

export const label = {
	user: () => pc.bgGreen(pc.black(" USER ")),
	agent: () => pc.bgYellow(pc.black(" AGENT ")),
	tool: () => pc.bgBlue(pc.black(" TOOL ")),
	system: () => pc.bgMagenta(pc.black(" SYS ")),
} as const;

// ── 文本样式 ──

export const style = {
	dim: pc.dim,
	gray: pc.gray,
	green: pc.green,
	red: pc.red,
	yellow: pc.yellow,
	cyan: pc.cyan,
	bold: pc.bold,
	white: pc.white,
	bgGreen: pc.bgGreen,
} as const;

// ── 光标控制（写入 stderr） ──

/** 光标上移 n 行 */
export function cursorUp(n: number): void {
	if (n > 0) out.write(`\x1b[${n}A`);
}

/** 清除当前行 + 光标移到行首 */
export function clearLine(): void {
	out.write("\x1b[2K\x1b[0G");
}

/** 清除从光标到行尾 */
export function clearToEnd(): void {
	out.write("\x1b[0K");
}

/** 隐藏光标 */
export function hideCursor(): void {
	out.write("\x1b[?25l");
}

/** 显示光标 */
export function showCursor(): void {
	out.write("\x1b[?25h");
}

/** 写入 stderr（不换行） */
export function write(text: string): void {
	out.write(text);
}

/** 写入 stderr（换行） */
export function writeln(text = ""): void {
	out.write(`${text}\n`);
}

/** 检测是否为 TTY（支持 ANSI） */
export const isTTY: boolean = out.isTTY ?? false;
