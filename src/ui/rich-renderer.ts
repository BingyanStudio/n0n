/**
 * RichRenderer — 富终端 UI 渲染器
 *
 * 彩色角色标签、流式 thinking/content、diff 格式 write 显示、
 * 工具输出渲染（超长折叠）、LiveRegion 行替换。
 */

import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import { label, style, write, writeln } from "./ansi.ts";
import { LiveRegion } from "./live-region.ts";
import type { Renderer } from "./renderer.ts";

/** 截断过长文本：保留头部 headLen + 尾部 tailLen，中间折叠 */
function truncateMiddle(
	text: string,
	maxLen = 1000,
	headLen = 200,
	tailLen = 800,
): string {
	if (text.length <= maxLen) return text;
	const head = text.slice(0, headLen);
	const tail = text.slice(-tailLen);
	const omitted = text.length - headLen - tailLen;
	return `${head}\n${style.gray(`... (${omitted} chars omitted) ...`)}\n${tail}`;
}

export class RichRenderer implements Renderer {
	private toolRegion = new LiveRegion();
	private hasStreamContent = false;

	userMessage(content: string): void {
		writeln();
		writeln(label.user());
		writeln(content);
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		writeln();
		write(label.agent());
		writeln(style.gray(`  round ${round}/${maxRounds} (${msgCount} msgs)`));
	}

	thinkingToken(token: string): void {
		write(style.gray(token));
		this.hasStreamContent = true;
	}

	contentToken(token: string): void {
		write(token);
		this.hasStreamContent = true;
	}

	contentEnd(): void {
		if (this.hasStreamContent) {
			writeln();
			this.hasStreamContent = false;
		}
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			writeln(content);
		}
		writeln(
			style.gray(`(text response, ${content.length} chars, idle=${idleCount})`),
		);
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.toolRegion.reset();
		const toolName = style.cyan(tc.tool);

		switch (tc.tool) {
			case "exec": {
				const cmd = (tc.args as { command?: string }).command ?? "";
				this.toolRegion.writeln(
					`${style.dim("▸")} ${toolName} ${cmd.slice(0, 100)}`,
				);
				break;
			}
			case "write": {
				const args = tc.args as {
					path?: string;
					search?: string;
					replace?: string;
				};
				const path = args.path ?? "";
				this.toolRegion.writeln(`${style.dim("▸")} ${toolName} → ${path}`);
				if (args.search) {
					const searchLines = args.search.split("\n");
					const replaceLines = (args.replace ?? "").split("\n");
					const maxPreview = 8;
					for (const line of searchLines.slice(0, maxPreview)) {
						this.toolRegion.writeln(`  ${style.red(`- ${line}`)}`);
					}
					if (searchLines.length > maxPreview) {
						this.toolRegion.writeln(
							style.gray(
								`  ... (${searchLines.length - maxPreview} more lines)`,
							),
						);
					}
					for (const line of replaceLines.slice(0, maxPreview)) {
						this.toolRegion.writeln(`  ${style.green(`+ ${line}`)}`);
					}
					if (replaceLines.length > maxPreview) {
						this.toolRegion.writeln(
							style.gray(
								`  ... (${replaceLines.length - maxPreview} more lines)`,
							),
						);
					}
				} else {
					const lines = (args.replace ?? "").split("\n").length;
					this.toolRegion.writeln(style.gray(`  (full write, ${lines} lines)`));
				}
				break;
			}
			case "reminder": {
				const content = (tc.args as { content?: string }).content ?? "";
				this.toolRegion.writeln(
					`${style.dim("▸")} ${toolName} ${content.slice(0, 60)}`,
				);
				break;
			}
			case "submit": {
				this.toolRegion.writeln(`${style.dim("▸")} ${toolName}`);
				break;
			}
			default: {
				this.toolRegion.writeln(`${style.dim("▸")} ${toolName}`);
			}
		}
	}

	toolCallArgChunk(_index: number, _chunk: string): void {
		// Future: live streaming of tool args
	}

	toolCallEnd(result: ToolResult): void {
		const summary = this.formatToolResult(result);
		this.toolRegion.replace(summary);
	}

	submitAccepted(): void {
		writeln();
		writeln(
			`${style.bgGreen(style.bold(" ✔ DONE "))} ${style.green("submit accepted")}`,
		);
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		writeln(
			`${style.red("✗")} submit rejected (${attempt}/${maxAttempts}): ${style.gray(error)}`,
		);
	}

	agentTerminated(reason: string): void {
		writeln();
		writeln(`${style.yellow("⚠")} ${style.gray(reason)}`);
	}

	// ── 工具结果格式化 ──

	private formatToolResult(result: ToolResult): string {
		switch (result.tool) {
			case "exec": {
				const duration = style.gray(
					`${(result.durationMs / 1000).toFixed(1)}s`,
				);
				const exit =
					result.exitCode === 0
						? style.green(`exit=${result.exitCode}`)
						: style.red(`exit=${result.exitCode}`);
				const outLen = result.stdout.length + result.stderr.length;
				const cmd = result.command.slice(0, 80);
				// 结果摘要行
				let out = `${style.dim("◂")} ${style.cyan("exec")} ${cmd} ${duration} ${exit} ${style.gray(`${outLen} chars`)}\n`;
				// 工具输出内容（缩进，表示从属）
				const output = (
					result.stdout + (result.stderr ? `\n${result.stderr}` : "")
				).trim();
				if (output) {
					const truncated = truncateMiddle(output);
					for (const line of truncated.split("\n")) {
						out += `${style.gray("  │")} ${style.dim(line)}\n`;
					}
				}
				return out;
			}
			case "write": {
				if (!result.success) {
					return `${style.dim("◂")} ${style.cyan("write")} ${result.path}: ${style.red(result.error ?? "failed")}\n`;
				}
				if (result.searchPattern) {
					const searchLines = result.searchPattern.split("\n").length;
					return `${style.dim("◂")} ${style.cyan("write")} ${result.path} ${style.gray(`(replaced ${result.replacedCount}×, ~${searchLines} lines)`)}\n`;
				}
				return `${style.dim("◂")} ${style.cyan("write")} ${result.path} ${style.gray("(full write)")}\n`;
			}
			case "reminder": {
				return `${style.dim("◂")} ${style.cyan("reminder")} ${style.gray(`(in ${result.delay} rounds)`)}\n`;
			}
			case "submit": {
				return `${style.dim("◂")} ${style.cyan("submit")}\n`;
			}
		}
	}
}
