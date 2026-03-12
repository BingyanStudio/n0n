/**
 * CliSetupRenderer — 终端环境下的 SetupRenderer 实现
 *
 * 使用 ANSI 颜色 + node:readline 实现交互式引导。
 * 密码输入通过 raw mode 实现不回显。
 *
 * readline 按需创建/重建，避免 stdin EOF 或 raw mode 切换导致的
 * ERR_USE_AFTER_CLOSE 问题。
 */

import { createInterface, type Interface } from "node:readline";
import type { SetupOption, SetupRenderer } from "@n0n/types";
import { style, writeln } from "./ansi.ts";

export class CliSetupRenderer implements SetupRenderer {
	private rl: Interface | null = null;

	/** 获取或创建 readline（如已关闭则重建） */
	private getRL(): Interface {
		if (this.rl) return this.rl;
		this.rl = createInterface({
			input: process.stdin,
			output: process.stderr,
			terminal: process.stderr.isTTY ?? false,
		});
		this.rl.on("close", () => {
			this.rl = null;
		});
		return this.rl;
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
			this.getRL().question(`${prompt}${hint}: `, (answer) => {
				resolve(answer.trim() || defaultValue || "");
			});
		});
	}

	secret(prompt: string): Promise<string> {
		return new Promise((resolve) => {
			const stdin = process.stdin;
			if (stdin.isTTY) {
				// 关闭当前 readline 以避免 raw mode 冲突
				this.rl?.close();
				this.rl = null;

				process.stderr.write(`${prompt}: `);
				stdin.setRawMode(true);
				stdin.resume();
				let buf = "";
				const onData = (data: Buffer) => {
					const char = data.toString();
					if (char === "\r" || char === "\n") {
						stdin.setRawMode(false);
						stdin.removeListener("data", onData);
						process.stderr.write("\n");
						// readline 会在下次 getRL() 时重建
						resolve(buf);
						return;
					}
					if (char === "\u0003") {
						stdin.setRawMode(false);
						process.stderr.write("\n");
						process.exit(1);
					}
					if (char === "\u007f" || char === "\b") {
						if (buf.length > 0) buf = buf.slice(0, -1);
						return;
					}
					buf += char;
				};
				stdin.on("data", onData);
			} else {
				this.getRL().question(`${prompt}: `, (answer) => {
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
			this.getRL().question(
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
			this.getRL().question(`${prompt} (${hint}): `, (answer) => {
				const a = answer.trim().toLowerCase();
				if (a === "") resolve(defaultYes);
				else resolve(a === "y" || a === "yes");
			});
		});
	}

	// ── 资源清理 ──

	dispose(): void {
		this.rl?.close();
		this.rl = null;
	}
}
