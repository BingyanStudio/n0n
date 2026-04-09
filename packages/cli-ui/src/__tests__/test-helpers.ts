/**
 * cli-ui 测试公共工具
 *
 * 提供 stderr mock、VirtualTerminal harness、ANSI 处理等基础设施，
 * 避免每个测试文件重复定义。
 */

import { VirtualTerminal } from "./virtual-terminal.ts";

// ── ANSI 处理 ──

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

// ── stderr mock ──

/** 保存 stderr 原始状态，用于测试后恢复 */
export function saveStderr() {
	return {
		write: process.stderr.write,
		columns: process.stderr.columns,
		isTTY: process.stderr.isTTY,
	};
}

/** 恢复 stderr 到保存的状态 */
export function restoreStderr(saved: ReturnType<typeof saveStderr>): void {
	process.stderr.write = saved.write;
	Object.defineProperty(process.stderr, "columns", {
		value: saved.columns,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, "isTTY", {
		value: saved.isTTY,
		writable: true,
		configurable: true,
	});
}

/** 将 stderr 设为 TTY 模式，输出重定向到 VirtualTerminal */
export function setupVT(
	cols: number,
	opts?: { rows?: number; viewportHeight?: number },
): VirtualTerminal {
	const rows = opts?.rows ?? 500;
	const vt =
		opts?.viewportHeight != null
			? new VirtualTerminal(cols, rows, opts.viewportHeight)
			: new VirtualTerminal(cols, rows);
	Object.defineProperty(process.stderr, "isTTY", {
		value: true,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, "columns", {
		value: cols,
		writable: true,
		configurable: true,
	});
	process.stderr.write = (chunk: string | Uint8Array) => {
		if (typeof chunk === "string") vt.feed(chunk);
		return true;
	};
	return vt;
}

/** 将 stderr 静默（非 TTY，吞掉所有输出） */
export function muteStderr(): void {
	Object.defineProperty(process.stderr, "isTTY", {
		value: false,
		writable: true,
		configurable: true,
	});
	process.stderr.write = () => true;
}

// ── 输出捕获 ──

/** 将 stderr 重定向到字符串，返回获取结果的函数 */
export function captureStderr(): () => string {
	let buf = "";
	process.stderr.write = (chunk: string | Uint8Array) => {
		if (typeof chunk === "string") buf += chunk;
		else buf += new TextDecoder().decode(chunk);
		return true;
	};
	return () => buf;
}

// ── 杂项 ──

/** 将字符串按随机长度切成 chunks（确定性 PRNG） */
export function randomChunks(s: string, seed: number): string[] {
	const chunks: string[] = [];
	let pos = 0;
	let state = seed;
	while (pos < s.length) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		const size = (state % 5) + 1;
		chunks.push(s.slice(pos, pos + size));
		pos += size;
	}
	return chunks;
}
