/**
 * CSV 数据异常分析
 *
 * 演示：exec + 数据处理
 * 用法：CSV_PATH=data/sample.csv bun run src/main.ts run workflows/tasks/csv-analysis.ts
 */

import { delegateTask } from "../../src/index.ts";

export default async function run() {
	const csvPath = process.env.CSV_PATH ?? "data/sample.csv";

	const result = await delegateTask(
		`Analyze the CSV file at "${csvPath}" for anomalies. Read it, understand its structure, identify outliers/missing values/format errors. If the file doesn't exist, create sample data first. Submit a structured analysis report.`,
	);

	console.log(result.result);
	return result.result;
}
