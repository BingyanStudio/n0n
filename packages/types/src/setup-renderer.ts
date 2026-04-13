/**
 * SetupRenderer — 启动引导阶段的交互式 UI 抽象
 *
 * 独立于 Renderer（agent loop 事件渲染），原因：
 * - 不同生命周期：setup 在 agent loop 之前运行
 * - 不同交互模式：Renderer 是单向通知（fire-and-forget），SetupRenderer 是双向对话（需等待用户响应）
 * - 接口隔离：不强迫 Renderer 实现者实现 setup 方法
 *
 * CLI 实现：CliSetupRenderer（ANSI 颜色 + readline 交互）
 * 其他场景可提供自己的实现（如 Web 配置页）
 */

/** 选择项 */
export interface SetupOption {
	label: string;
	value: string;
}

/** 配置项来源 */
export type ConfigSource = "project" | "global" | "env" | "default" | "inherit" | "prefix";

/** 配置摘要条目 */
export interface ConfigEntry {
	key: string;
	value: string;
	source: ConfigSource;
	secret?: boolean;
	/** 被覆盖的原始值（如项目 .env 覆盖了全局 .env） */
	overridden?: { value: string; source: ConfigSource };
}

/** 配置摘要分组 */
export interface ConfigGroup {
	title: string;
	entries: ConfigEntry[];
}

export interface SetupRenderer {
	/** 普通信息 */
	info(message: string): void;
	/** 成功信息 */
	success(message: string): void;
	/** 警告信息 */
	warn(message: string): void;
	/** 错误信息 */
	error(message: string): void;

	/** 文本输入（带可选默认值） */
	input(prompt: string, defaultValue?: string): Promise<string>;
	/** 密码输入（不回显） */
	secret(prompt: string): Promise<string>;
	/** 单选（返回选中项的 value） */
	select(prompt: string, options: SetupOption[]): Promise<string>;
	/** 确认（y/n） */
	confirm(prompt: string, defaultYes?: boolean): Promise<boolean>;

	/**
	 * 渲染配置摘要表格（可选实现）。
	 * 未实现时 runner 会 fallback 到 info() 输出纯文本。
	 */
	configTable?(groups: ConfigGroup[], overrides: ConfigEntry[]): void;

	/** 销毁资源（如 readline interface） */
	dispose(): void;
}
