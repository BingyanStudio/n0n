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
		contentDesc: "完成汇报——详细说明已完成的工作、验证结果和关键决策。",
	},
	{
		value: "working",
		statusDesc: "仍在进行中，汇报阶段性进展后继续工作。",
		contentDesc: "简述已完成什么、正在做什么、接下来计划做什么。",
	},
	{
		value: "blocked",
		statusDesc: "需要用户输入才能继续。",
		contentDesc: "向用户提出具体问题并提供 2-4 个选项。使用 DSL 格式：每选项以 `## ` 开头，下行写说明。",
	},
];
