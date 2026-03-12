/**
 * CliSetupRenderer — 终端环境下的 SetupRenderer 实现
 *
 * 使用 ANSI 颜色 + node:readline 实现交互式引导。
 * 密码输入通过 raw mode 实现不回显。
 */

import { createInterface, type Interface } from "node:readline";
import type { SetupOption, SetupRenderer } from "@n0n/types";
import { style, writeln } from "./ansi.ts";

export class CliSetupRenderer implements SetupRenderer {
	private rl: Interface;

	constructor() {
		this.rl = createInterface({
			input: process.stdin,
			output: process.stderr,
			terminal: process.stderr.isTTY ?? false,
		});
	}

	// ── 状态消息 ──

	info(message: string): void {
		writeln(`${style.cyan("ℹ")} ${message}`);
	}

	success(message: string): void {
		writeln(`${style.green("✓")} ${message}`);
	}

	warn(message: string): void {
		writeln(`${style.yellow("⚠")} ${message}`);
	}

	error(message: string): void {
		writeln(`${style.red("✗")} ${message}`);
	}

	// ── 交互式输入 ──

	input(prompt: string, defaultValue?: string): Promise<string> {
		const hint = defaultValue ? style.gray(` (${defaultValue})`) : "";
		return new Promise((resolve) => {
			this.rl.question(`${prompt}${hint}: `, (answer) => {
				resolve(answer.trim() || defaultValue || "");
			});
		});
	}

	secret(prompt: string): Promise<string> {
		return new Promise((resolve) => {
			// 如果是 TTY，使用 raw mode 隐藏输入
			const stdin = process.stdin;
			if (stdin.isTTY) {
				process.stderr.write(`${prompt}: `);
				stdin.setRawMode(true);
				stdin.resume();
				let buf = "";
				const onData = (data: Buffer) => {
					const char = data.toString();
					// Enter
					if (char === "\r" || char === "\n") {
						stdin.setRawMode(false);
						stdin.pause();
						stdin.removeListener("data", onData);
						process.stderr.write("\n");
						resolve(buf);
						return;
					}
					// Ctrl+C
					if (char === "\u0003") {
						stdin.setRawMode(false);
						process.stderr.write("\n");
						process.exit(1);
					}
					// Backspace
					if (char === "\u007f" || char === "\b") {
						if (buf.length > 0) buf = buf.slice(0, -1);
						return;
					}
					buf += char;
				};
				stdin.on("data", onData);
			} else {
				// 非 TTY 回退到普通输入
				this.rl.question(`${prompt}: `, (answer) => {
					resolve(answer.trim());
				});
			}
		});
	}

	select(prompt: string, options: SetupOption[]): Promise<string> {
		return new Promise((resolve) => {
			writeln(`${prompt}`);
			for (const [i, opt] of options.entries()) {
				writeln(`  ${style.cyan(`${i + 1})`)} ${opt.label}`);
			}
			this.rl.question(
				`${style.gray("选择")} (1-${options.length}): `,
				(answer) => {
					const idx = Number.parseInt(answer.trim(), 10) - 1;
					const picked =
						idx >= 0 && idx < options.length ? options[idx] : options[0];
					resolve(picked?.value ?? "");
				},
			);
		});
	}

	confirm(prompt: string, defaultYes = true): Promise<boolean> {
		const hint = defaultYes ? "Y/n" : "y/N";
		return new Promise((resolve) => {
			this.rl.question(`${prompt} (${hint}): `, (answer) => {
				const a = answer.trim().toLowerCase();
				if (a === "") resolve(defaultYes);
				else resolve(a === "y" || a === "yes");
			});
		});
	}

	// ── 资源清理 ──

	dispose(): void {
		this.rl.close();
	}
}
