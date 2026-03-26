/**
 * ServerSetupRenderer — 服务端环境下的 SetupRenderer 实现
 *
 * 与 CliSetupRenderer 的区别：
 * - 不使用 ANSI 颜色和 readline 交互
 * - 使用 console.log 输出配置信息，适合后台服务日志
 * - 交互式方法（input/secret/select/confirm）不可用，
 *   服务端应在启动前通过 .env 配好所有配置
 */

import type {
	ConfigEntry,
	ConfigGroup,
	SetupOption,
	SetupRenderer,
} from "@n0n/types";

export class ServerSetupRenderer implements SetupRenderer {
	private prefix: string;

	constructor(prefix = "[feishu]") {
		this.prefix = prefix;
	}

	info(message: string): void {
		console.log(`${this.prefix} ℹ ${message}`);
	}

	success(message: string): void {
		console.log(`${this.prefix} ✓ ${message}`);
	}

	warn(message: string): void {
		console.warn(`${this.prefix} ⚠ ${message}`);
	}

	error(message: string): void {
		console.error(`${this.prefix} ✗ ${message}`);
	}

	async input(_prompt: string, defaultValue?: string): Promise<string> {
		return defaultValue ?? "";
	}

	async secret(_prompt: string): Promise<string> {
		return "";
	}

	async select(_prompt: string, options: SetupOption[]): Promise<string> {
		return options[0]?.value ?? "";
	}

	async confirm(_prompt: string, defaultYes = true): Promise<boolean> {
		return defaultYes;
	}

	configTable(groups: ConfigGroup[], overrides: ConfigEntry[]): void {
		if (overrides.length > 0) {
			console.warn(
				`${this.prefix} ⚠ ${overrides.length} 项配置被项目 .env 覆盖:`,
			);
			for (const o of overrides) {
				const from = this.maskIfSecret(o.overridden?.value ?? "", o.secret);
				const to = this.maskIfSecret(o.value, o.secret);
				console.warn(`  • ${o.key}: ${from} → ${to}`);
			}
		}

		console.log(`${this.prefix} 当前配置:`);
		for (const group of groups) {
			console.log(`  ── ${group.title} ──`);
			for (const e of group.entries) {
				const val = this.maskIfSecret(e.value, e.secret);
				const src = this.sourceLabel(e.source);
				let line = `    ${e.key} = ${val}  [${src}]`;
				if (e.overridden) {
					const overVal = this.maskIfSecret(e.overridden.value, e.secret);
					line += `  ← 覆盖了${this.sourceLabel(e.overridden.source)}值 ${overVal}`;
				}
				console.log(line);
			}
		}
	}

	private maskIfSecret(value: string, secret?: boolean): string {
		if (!secret || !value) return value;
		if (value.length <= 8) return "****";
		return `${value.slice(0, 4)}…${value.slice(-4)}`;
	}

	private sourceLabel(source: string): string {
		switch (source) {
			case "project":
				return "项目";
			case "global":
				return "全局";
			case "inherit":
				return "继承";
			case "default":
				return "默认";
			case "env":
				return "环境变量";
			default:
				return source;
		}
	}

	dispose(): void {
		// 服务端无需清理资源
	}
}
