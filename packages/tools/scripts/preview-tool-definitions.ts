/**
 * 工具定义预览生成器
 *
 * 生成每个工具的完整 ToolDefinition，展示提交给模型时的精确 JSON 结构。
 * 输出到 packages/tools/scripts/preview-output/，供人工校验。
 *
 * 运行: bun run packages/tools/scripts/preview-tool-definitions.ts
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeToolkit } from "../src/index.ts";
import { CodeResultSchema } from "../../../apps/code/src/schema.ts";

const MODEL = "claude-sonnet-4-20250514";
const PREVIEW_DIR = join(import.meta.dir, "preview-output");
mkdirSync(PREVIEW_DIR, { recursive: true });

// 构建完整 toolkit（触发环境探测，与生产一致）
const toolkit = await makeToolkit(CodeResultSchema, {
	workspace: process.cwd(),
	tempDir: join(process.cwd(), ".temp"),
	security: { blockedCommands: [] },
	agent: { defaultExecWaitfor: 120 },
	editBackendType: "str-replace" as const,
	editorClient: {
		modelId: "",
		tagStyle: "default" as const,
		async *stream() { throw new Error("unused"); },
		async complete() { throw new Error("unused"); },
	},
}, MODEL);

let count = 0;
for (const def of toolkit.tools) {
	const lines = [
		`# Tool Definition: ${def.name}`,
		`<!-- generated for model: ${MODEL} -->`,
		"",
		"## parameters",
		"",
		"```json",
		JSON.stringify(def.parameters, null, 2),
		"```",
		"",
		"## description",
		"",
		"````",
		def.description,
		"````",
		"",
		"## Full OpenAI function format",
		"",
		"```json",
		JSON.stringify(
			{
				type: "function",
				function: {
					name: def.name,
					description: def.description,
					parameters: def.parameters,
				},
			},
			null,
			2,
		),
		"```",
		"",
	];

	const outPath = join(PREVIEW_DIR, `tool-${def.name}.preview.md`);
	await Bun.write(outPath, lines.join("\n"));
	count++;
	console.log(`  ${def.name} → ${outPath}`);
}

console.log(`\nGenerated ${count} tool previews in ${PREVIEW_DIR}/`);
