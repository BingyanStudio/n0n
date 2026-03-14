/**
 * StreamingContent — 流式内容显示组件
 *
 * 显示正在输出的 thinking 和 content 内容。
 */

import { Box, Text } from "ink";
import type React from "react";

interface StreamingContentProps {
	thinkingContent: string;
	contentBuffer: string;
	isThinking: boolean;
}

export const StreamingContent: React.FC<StreamingContentProps> = ({
	thinkingContent,
	contentBuffer,
	isThinking,
}) => {
	if (!thinkingContent && !contentBuffer) {
		return null;
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* Thinking 内容 */}
			{thinkingContent && (
				<Box>
					<Text dimColor>{formatStreamingText(thinkingContent)}</Text>
					{isThinking && <Text dimColor>{"█"}</Text>}
				</Box>
			)}

			{/* Content 内容 */}
			{contentBuffer && (
				<Box>
					<Text>{formatStreamingText(contentBuffer)}</Text>
				</Box>
			)}
		</Box>
	);
};

function formatStreamingText(text: string): string {
	// 截断过长的流式内容，保留最后部分
	const maxChars = 500;
	if (text.length > maxChars) {
		return `...${text.slice(-maxChars)}`;
	}
	return text;
}
