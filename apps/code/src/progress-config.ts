/**
 * Code Agent progress 工具配置
 *
 * 定义 code agent 的三种 progress status：
 * - completed: 任务完成
 * - working: 阶段性进展
 * - blocked: 需要用户输入
 */

import type { ProgressStatusConfig } from "@n0n/tools";

export const codeProgressConfig: ProgressStatusConfig[] = [
	{
		value: "completed",
		statusDesc: "任务完成，提交最终汇报。假定用户已失去上下文，务必完整自包含。",
		contentDesc:
			"完成汇报——详细说明已完成的工作、验证结果和关键决策。可选在末尾用 `---` 分隔后附后续步骤建议。",
	},
	{
		value: "working",
		statusDesc: "仍在进行中，汇报阶段性进展后继续工作。",
		contentDesc: "展示关键判断及其依据——做了什么判断、基于什么证据、排除了什么替代方案。供用户检查推导过程、定位假设偏差。",
	},
	{
		value: "blocked",
		statusDesc: "需要用户输入才能继续。",
		contentDesc: [
			"向用户提出具体问题，并提供 2-4 个选项供选择。",
			"格式：先写问题描述，然后用选项 DSL——每个选项以 `## ` 开头作为标题行，下一行写详细说明。示例：",
			"",
			"需要决定数据库迁移策略。",
			"## 方案 A：就地迁移",
			"直接修改现有表结构，改动量最小但有短暂停机风险",
			"## 方案 B：双写过渡",
			"新旧表并行写入，零停机但实现复杂度更高",
		].join("\n"),
	},
];
