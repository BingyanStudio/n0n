import { readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";
import type { PendingReminder, ToolPlugin } from "./plugin.ts";

interface ToolModule {
	TOOL_PLUGIN?: ToolPlugin;
}

function getPluginName(plugin: ToolPlugin): string {
	return plugin.definition.function.name;
}

async function discoverToolPlugins(): Promise<ToolPlugin[]> {
	const currentFile = fileURLToPath(import.meta.url);
	const toolsDir = dirname(currentFile);
	const entries = (await readdir(toolsDir, { withFileTypes: true }))
		.filter(
			(entry) =>
				entry.isFile() &&
				extname(entry.name) === ".ts" &&
				entry.name !== "index.ts" &&
				entry.name !== "plugin.ts",
		)
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));

	const plugins: ToolPlugin[] = [];

	for (const entryName of entries) {
		const moduleUrl = pathToFileURL(join(toolsDir, entryName)).href;
		const mod = (await import(moduleUrl)) as ToolModule;
		if (!mod.TOOL_PLUGIN) continue;
		plugins.push(mod.TOOL_PLUGIN);
	}

	const names = new Set<string>();
	for (const plugin of plugins) {
		const name = getPluginName(plugin);
		if (names.has(name)) {
			throw new Error(`Duplicate tool plugin name detected: ${name}`);
		}
		names.add(name);
	}

	return plugins;
}

const TOOL_PLUGINS = Object.freeze(await discoverToolPlugins());
const TOOL_PLUGIN_MAP = new Map(TOOL_PLUGINS.map((p) => [getPluginName(p), p]));

export const TOOL_DEFINITIONS: LLMToolDefinition[] = TOOL_PLUGINS.map(
	(plugin) => plugin.definition,
);

export function hasRegisteredTool(toolName: string): boolean {
	return TOOL_PLUGIN_MAP.has(toolName);
}

export async function executeRegisteredTool(
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
): Promise<ToolResult> {
	const plugin = TOOL_PLUGIN_MAP.get(tc.tool);
	if (!plugin) {
		return {
			type: "tool_result",
			callId: tc.id,
			tool: tc.tool,
			error: `Unknown tool: ${tc.tool}`,
		};
	}

	return plugin.execute(tc.id, tc.args, { reminders, confirmFn });
}

export { ENV_INFO, EXEC_TOOL_DEFINITION, execTool } from "./exec.ts";
export type { PendingReminder, ToolExecutionContext, ToolPlugin } from "./plugin.ts";
export { REMINDER_TOOL_DEFINITION, reminderTool } from "./reminder.ts";
export { SUBMIT_TOOL_DEFINITION, submitTool } from "./submit.ts";
export { WRITE_TOOL_DEFINITION, writeTool } from "./write.ts";

