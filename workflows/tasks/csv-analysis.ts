/**
 * CSV 数据异常分析
 *
 * 演示：exec + 数据处理
 * 用法：bun run src/main.ts run workflows/tasks/csv-analysis.ts
 *
 * 期望当前目录下有 data/sample.csv，或通过参数指定路径。
 */

import { subagent } from "../../src/index.ts";

export default async function run() {
	const csvPath = process.env.CSV_PATH ?? "data/sample.csv";

	const result = await subagent(
		[
			`Analyze the CSV file at "${csvPath}" and find anomalies.`,
			"",
			"Steps:",
			"1. Use `exec` to read the file (head, wc -l, etc.) to understand its structure",
			"2. Use `exec` to run analysis commands (awk, sort, uniq -c, etc.)",
			"3. Identify statistical outliers, missing values, or unexpected patterns",
			"4. Submit a structured report with your findings",
			"",
			"If the file doesn't exist, create a sample CSV with some anomalous data first,",
			"then analyze it.",
		].join("\n"),
		{ maxIterations: 25 },
	);

	return result.result;
}
