/**
 * EnvSpec — 应用环境配置规格声明
 *
 * 每个 app 声明自己需要的环境变量，bootstrap 模块据此：
 * 1. 检测缺失的必填变量
 * 2. 生成带注释的 .env 模板
 * 3. 交互式引导用户填写
 *
 * 共享变量（如 LLM 三件套）定义在 packages/shared/bootstrap 中，
 * 各 app 通过展开运算符组合共享 + 专属变量。
 */

/** 单个环境变量的描述 */
export interface EnvVarDef {
	/** 环境变量名 */
	key: string;
	/** 人类可读描述 */
	desc: string;
	/** 示例值（用于 .env 模板和交互提示） */
	example?: string;
	/** 默认值（有默认值的变量缺失时不报错） */
	default?: string;
	/** 是否为敏感信息（输入时不回显） */
	secret?: boolean;
}

/** 环境变量分组（用于 .env 模板的分段注释） */
export interface EnvGroup {
	/** 分组标题 */
	title: string;
	/** 该组内的变量 */
	vars: EnvVarDef[];
}

/** 完整的应用环境配置规格 */
export interface EnvSpec {
	/** 应用名称（用于 .env 模板标题） */
	appName: string;
	/** 变量分组（按逻辑分段，生成 .env 时保留分组结构） */
	groups: EnvGroup[];
}

/** bootstrap 检测结果 */
export interface BootstrapResult {
	/** 是否全部通过 */
	ok: boolean;
	/** 最终生效的环境变量 */
	env: Record<string, string>;
	/** 跳过的检测项 */
	skipped: string[];
}
