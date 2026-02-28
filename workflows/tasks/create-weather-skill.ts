/**
 * 创建天气查询 Skill 并在新 workflow 中使用它
 *
 * 演示：自扩展（AI 创建 skill → 使用 skill）
 * 用法：bun run src/main.ts run workflows/tasks/create-weather-skill.ts
 */

import { delegateTask } from "../../src/index.ts";

export default async function run() {
	// Step 1: 创建 skill
	const createResult = await delegateTask(
		"Create a weather query skill at workflows/skills/weather.ts. It should export a default async function that takes a city name, uses wttr.in API (curl wttr.in/CityName?format=j1), and returns { city, temperature, condition, humidity }. Add a JSDoc comment. Test it. Submit the file path.",
	);

	console.log("✅ Skill created:", createResult.result);

	// Step 2: 使用 skill
	const useResult = await delegateTask(
		"Create workflows/tasks/weather-report.ts that imports the weather skill from workflows/skills/weather.ts, queries weather for Tokyo, London, New York, and generates a formatted comparison report. Test it. Submit the report.",
	);

	return useResult.result;
}
