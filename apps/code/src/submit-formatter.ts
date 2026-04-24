/**
 * Submit 结果格式化 — 将已验证的 CodeResult 渲染为 Markdown 文档
 */

import type { CodeResult } from "./schema.ts";
// ── Markdown 模板 ──

const COMPLETED_TEMPLATE = `# ✅ 任务完成

## 总结

{{summary}}
{{#next_step}}

---

## 下一步

{{next_step}}
{{/next_step}}
`;

const ASK_USER_TEMPLATE = `# ❓ 需要确认
{{question}}

---
{{options}}
`;

const REQUEST_ASSIST_TEMPLATE = `# 🔧 请求协助
{{content}}

---
{{checklist}}
`;

// ── 模板引擎 ──

/**
 * 最小模板渲染：替换 {{key}} 占位符，处理 {{#key}}...{{/key}} 条件块。
 * 条件块：值为空字符串时整块（含标记行）移除，否则移除标记行保留内容。
 */
function render(template: string, vars: Record<string, string>): string {
	let result = template;

	result = result.replace(
		/\{\{#(\w+)\}\}\n([\s\S]*?)\{\{\/\1\}\}\n?/g,
		(_, key: string, body: string) => {
			if (!vars[key]) return "";
			return body;
		},
	);

	result = result.replace(
		/\{\{(\w+)\}\}/g,
		(_, key: string) => vars[key] ?? "",
	);

	return result;
}

// ── 导出 ──

export function formatSubmitResult(result: CodeResult): string {
	switch (result.type) {
		case "completed":
			return render(COMPLETED_TEMPLATE, {
				summary: result.summary,
				next_step: result.next_step ?? "",
			});
		case "ask_user":
			return render(ASK_USER_TEMPLATE, {
				question: result.question,
				options: result.options,
			});
		case "request_assist":
			return render(REQUEST_ASSIST_TEMPLATE, {
				content: result.content,
				checklist: result.checklist,
			});
	}
}
