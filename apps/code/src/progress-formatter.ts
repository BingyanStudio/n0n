/**
 * Progress 结果格式化 — 将已验证的 CodeProgressResult 渲染为 Markdown 文档
 */

import type { CodeProgressResult } from "./schema.ts";

export function formatProgressResult(result: CodeProgressResult): string {
	switch (result.status) {
		case "completed":
			return `# ✅ 任务完成\n\n${result.content}\n`;
		case "working":
			return `# ⏳ 进行中\n\n${result.content}\n`;
		case "blocked":
			return `# ❓ 需要确认\n\n${result.content}\n`;
	}
}
