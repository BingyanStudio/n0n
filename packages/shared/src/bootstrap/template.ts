/**
 * template — .env 模板生成
 *
 * 根据 EnvSpec 生成带注释的 .env 文件内容。
 * 分组结构保留，每个变量附带描述和示例。
 */

import type { EnvSpec, EnvVarDef } from "@n0n/types";

function varLine(v: EnvVarDef, withValue?: string): string {
	const lines: string[] = [];
	const isOptional = v.default !== undefined;
	const hasInherit = !!v.inheritFrom;
	const tag = isOptional ? "[可选]" : hasInherit ? "[继承]" : "[必填]";

	lines.push(`# ${tag} ${v.desc}`);
	if (hasInherit && !withValue) {
		// 继承变量未自定义：注释掉，标注继承来源
		lines.push(`# 未设置时继承自 ${v.inheritFrom}`);
		lines.push(`# ${v.key}=`);
	} else if (v.example && !withValue) {
		lines.push(`# 示例: ${v.example}`);
		const value = withValue ?? v.default ?? "";
		if (isOptional) {
			lines.push(`# ${v.key}=${value}`);
		} else {
			lines.push(`${v.key}=${value}`);
		}
	} else {
		const value = withValue ?? v.default ?? "";
		if (isOptional && !withValue) {
			lines.push(`# ${v.key}=${value}`);
		} else {
			lines.push(`${v.key}=${value}`);
		}
	}

	return lines.join("\n");
}

/**
 * 生成带注释的 .env 模板
 * @param spec 应用配置规格
 * @param existing 已有的环境变量值（用于保留用户已填的值）
 */
export function generateEnvTemplate(
	spec: EnvSpec,
	existing?: Record<string, string>,
): string {
	const sections: string[] = [];

	// 标题
	sections.push(
		[
			`# ${"═".repeat(50)}`,
			`# ${spec.appName} 配置`,
			`# ${"═".repeat(50)}`,
		].join("\n"),
	);

	for (const group of spec.groups) {
		const groupLines: string[] = [];
		groupLines.push("");
		groupLines.push(`# -- ${group.title} --`);
		groupLines.push("");

		for (const v of group.vars) {
			const existingVal = existing?.[v.key];
			groupLines.push(varLine(v, existingVal));
			groupLines.push("");
		}

		sections.push(groupLines.join("\n"));
	}

	return sections.join("\n");
}
