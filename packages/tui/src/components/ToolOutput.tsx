/**
 * ToolOutput — 工具输出显示组件
 *
 * 显示工具调用信息、执行状态和输出。
 * 支持多行输出和滚动摘要。
 */

import { Box, Text } from "ink";
import type React from "react";
import type { CompletedToolCall } from "../state.ts";

interface ToolOutputProps {
	toolCall: CompletedToolCall;
}

export const ToolOutput: React.FC<ToolOutputProps> = ({ toolCall }) => {
	const { tool, args, status, output, result, durationMs } = toolCall;

	// 格式化参数显示
	const argsPreview = formatArgs(tool, args);

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* 工具名称和状态 */}
			<Box>
				<Text dimColor>{"◂"}</Text>
				<Text color="cyan">{` ${tool}`}</Text>
				{status === "running" && <Text dimColor>{" (running...)"}</Text>}
				{status === "completed" && durationMs && (
					<Text dimColor>{` ${(durationMs / 1000).toFixed(1)}s`}</Text>
				)}
			</Box>

			{/* 参数预览 */}
			{argsPreview && (
				<Box marginLeft={2}>
					<Text dimColor>{argsPreview}</Text>
				</Box>
			)}

			{/* 执行输出（截取前几行） */}
			{output && (
				<Box marginLeft={2} flexDirection="column">
					{formatOutput(output).map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static output lines
						<Text key={`output-line-${i}`} dimColor>
							{`│ ${line}`}
						</Text>
					))}
				</Box>
			)}

			{/* 结果摘要 */}
			{result && (
				<Box marginLeft={2}>
					<Text dimColor>{formatResult(result)}</Text>
				</Box>
			)}
		</Box>
	);
};

function formatArgs(tool: string, args: Record<string, unknown>): string {
	switch (tool) {
		case "exec": {
			const script = args.script;
			if (typeof script === "string") {
				return script.length > 80 ? `${script.slice(0, 80)}...` : script;
			}
			return "";
		}
		case "write":
		case "vim_edit":
			return typeof args.path === "string" ? args.path : "";
		case "reminder":
			return `delay=${args.delay}`;
		default:
			return "";
	}
}

function formatOutput(output: string): string[] {
	const lines = output.split("\n").filter((l) => l.trim());
	const maxLines = 5;

	if (lines.length <= maxLines) {
		return lines;
	}

	return [
		...lines.slice(0, maxLines),
		`... (${lines.length - maxLines} more lines)`,
	];
}

function formatResult(result: {
	tool: string;
	success?: boolean;
	exitCode?: number;
	linesAdded?: number;
	linesRemoved?: number;
	error?: string | null;
}): string {
	switch (result.tool) {
		case "exec":
			return result.exitCode === 0 ? "exit=0" : `exit=${result.exitCode}`;
		case "write":
		case "vim_edit":
			if (result.success === false) {
				return result.error ?? "failed";
			}
			if (
				result.linesAdded !== undefined &&
				result.linesRemoved !== undefined
			) {
				return `+${result.linesAdded} -${result.linesRemoved} lines`;
			}
			return "ok";
		default:
			return "";
	}
}
