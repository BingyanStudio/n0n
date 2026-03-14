/**
 * MessageRow — 消息显示组件
 *
 * 根据消息类型渲染不同样式：
 * - user: 绿色标签
 * - agent: 黄色标签
 * - thinking: 灰色斜体
 * - content: 普通文本
 * - tool: 蓝色标签
 * - system: 紫色标签
 */

import { Box, Text } from "ink";
import type React from "react";
import type { Message } from "../state.ts";

interface MessageRowProps {
	message: Message;
}

export const MessageRow: React.FC<MessageRowProps> = ({ message }) => {
	const label = getLabel(message.type);
	const content = formatContent(message.content);

	switch (message.type) {
		case "user":
			return (
				<Box flexDirection="column" marginBottom={1}>
					<Box>
						<Text bold color="green">
							{label}
						</Text>
					</Box>
					<Box marginLeft={2}>
						<Text>{content}</Text>
					</Box>
				</Box>
			);

		case "thinking":
			return (
				<Box marginBottom={1}>
					<Text dimColor>{content}</Text>
				</Box>
			);

		case "content":
			return (
				<Box marginBottom={1}>
					<Text>{content}</Text>
				</Box>
			);

		case "tool":
			return (
				<Box marginBottom={1}>
					<Text bold color="blue">
						{label}
					</Text>
					<Text>{` ${content}`}</Text>
				</Box>
			);

		case "system":
			return (
				<Box marginBottom={1}>
					<Text bold color="magenta">
						{label}
					</Text>
					<Text dimColor>{` ${content}`}</Text>
				</Box>
			);

		default:
			return (
				<Box marginBottom={1}>
					<Text>{content}</Text>
				</Box>
			);
	}
};

function getLabel(type: Message["type"]): string {
	switch (type) {
		case "user":
			return " USER ";
		case "agent":
			return " AGENT ";
		case "tool":
			return " TOOL ";
		case "system":
			return " SYS ";
		default:
			return "";
	}
}

function formatContent(content: string): string {
	// 截断过长的单行内容
	const maxLineLength = 200;
	const lines = content.split("\n");

	return lines
		.map((line) =>
			line.length > maxLineLength ? `${line.slice(0, maxLineLength)}...` : line,
		)
		.join("\n");
}
