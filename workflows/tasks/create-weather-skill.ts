/**
 * 创建天气查询 Skill 并在新 workflow 中使用它
 *
 * 演示：自扩展（AI 创建 skill → 使用 skill）
 * 用法：bun run src/main.ts run workflows/tasks/create-weather-skill.ts
 */

import { subagent } from "../../src/index.ts";

export default async function run() {
	// Step 1: 让 AI 创建一个天气查询 skill
	const createResult = await subagent(
		[
			"Create a weather query skill as a TypeScript file.",
			"",
			"Requirements:",
			"1. Create file: workflows/skills/weather.ts",
			"2. It should export a default async function that accepts a city name",
			"3. Use wttr.in API (curl wttr.in/CityName?format=j1) to fetch weather",
			"4. Return structured data: { city, temperature, condition, humidity }",
			"5. Add a JSDoc comment at the top describing the skill",
			"6. Test it by running: bun run workflows/skills/weather.ts",
			"",
			"Submit the file path as your result.",
		].join("\n"),
		{ maxIterations: 20 },
	);

	console.log("✅ Skill created:", createResult.result);

	// Step 2: 在新 workflow 中使用这个 skill
	const useResult = await subagent(
		[
			"Create a new workflow that uses the weather skill we just created.",
			"",
			"Requirements:",
			"1. Create file: workflows/tasks/weather-report.ts",
			"2. Import the weather skill from workflows/skills/weather.ts",
			"3. Query weather for 3 cities: Tokyo, London, New York",
			"4. Generate a formatted comparison report",
			"5. Run the workflow to verify it works",
			"",
			"Submit the formatted weather report as your result.",
		].join("\n"),
		{ maxIterations: 20 },
	);

	return useResult.result;
}
