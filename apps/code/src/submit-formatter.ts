/**
 * Submit 结果格式化 — 将已验证的 CodeResult 渲染为 Markdown 文档
 */

import type { CodeResult } from "./schema.ts";

type AskUserResult = Extract<CodeResult, { type: "ask_user" }>;
type RequestAssistResult = Extract<CodeResult, { type: "request_assist" }>;

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

## 问题

{{question}}

## 选项

{{options}}
`;

const REQUEST_ASSIST_TEMPLATE = `# 🔧 请求协助

{{content}}

## 检查列表

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

	result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");

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
				options: formatOptions(result.options),
			});
		case "request_assist":
			return render(REQUEST_ASSIST_TEMPLATE, {
				content: result.content,
				checklist: formatChecklist(result.checklist),
			});
	}
}

// ── 内部辅助 ──

function formatOptions(options: AskUserResult["options"]): string {
	const lines: string[] = [];
	for (const [i, opt] of options.entries()) {
		lines.push(`### ${i + 1}. ${opt.choice}`);
		if (opt.affect) {
			lines.push("");
			lines.push(`> ${opt.affect}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function formatChecklist(checklist: RequestAssistResult["checklist"]): string {
	const lines: string[] = [];
	for (const item of checklist) {
		lines.push(`- [ ] ${item.label}`);
		if (item.detail) {
			lines.push(`  > ${item.detail}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}
