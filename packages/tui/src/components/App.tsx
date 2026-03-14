/**
 * TuiApp — 主 TUI 组件
 *
 * 布局：
 * - 上方：消息历史（滚动区域）
 * - 中间：工具输出区域
 * - 下方：输入框
 * - 底部：状态栏
 */

import { Box, Text } from "ink";
import type React from "react";
import type { TuiRendererState } from "../state.ts";
import { InputBox } from "./InputBox.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { StreamingContent } from "./StreamingContent.tsx";
import { ToolOutput } from "./ToolOutput.tsx";

interface TuiAppProps {
	state: TuiRendererState;
	/** 输入提交回调 */
	onInputSubmit?: (text: string) => void;
	/** 是否等待用户输入 */
	waitingForInput?: boolean;
}

export const TuiApp: React.FC<TuiAppProps> = ({
	state,
	onInputSubmit,
	waitingForInput = true,
}) => {
	const { messages, streamingToolCalls, completedToolCalls, round } = state;

	return (
		<Box flexDirection="column" padding={0}>
			{/* 轮次信息 */}
			{round && (
				<Box marginBottom={1}>
					<Text bold color="yellow">
						{" AGENT "}
					</Text>
					<Text dimColor>
						{` round ${round.current}/${round.max} (${round.msgCount} msgs)`}
					</Text>
				</Box>
			)}

			{/* 消息历史 */}
			{messages.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					{messages.map((msg) => (
						<MessageRow key={msg.id} message={msg} />
					))}
				</Box>
			)}

			{/* 流式内容（thinking/content） */}
			<StreamingContent
				thinkingContent={state.thinkingContent}
				contentBuffer={state.contentBuffer}
				isThinking={state.isThinking}
			/>

			{/* 流式工具调用参数 */}
			{streamingToolCalls.size > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					{[...streamingToolCalls.entries()]
						.sort((a, b) => a[0] - b[0])
						.map(([index, tc]) => (
							<StreamingToolCallRow key={index} toolCall={tc} />
						))}
				</Box>
			)}

			{/* 已完成的工具调用 */}
			{completedToolCalls.length > 0 && (
				<Box flexDirection="column">
					{completedToolCalls.map((tc) => (
						<ToolOutput key={tc.id} toolCall={tc} />
					))}
				</Box>
			)}

			{/* 最终状态 */}
			{state.finalStatus && (
				<FinalStatus
					status={state.finalStatus}
					submitError={state.submitError}
					terminationReason={state.terminationReason}
				/>
			)}

			{/* 输入框 */}
			{waitingForInput && state.finalStatus === null && (
				<InputBox
					onSubmit={(text) => onInputSubmit?.(text)}
					disabled={!waitingForInput || state.finalStatus !== null}
				/>
			)}
		</Box>
	);
};

/** 流式工具调用参数显示 */
const StreamingToolCallRow: React.FC<{
	toolCall: { index: number; name: string; args: string };
}> = ({ toolCall }) => {
	return (
		<Box flexDirection="column">
			<Box>
				<Text dimColor>{"▸"}</Text>
				<Text color="cyan">{` ${toolCall.name}`}</Text>
				<Text dimColor>{" (streaming...)"}</Text>
			</Box>
			{toolCall.args.length > 0 && (
				<Box marginLeft={2}>
					<Text dimColor>{toolCall.args.slice(0, 100)}</Text>
				</Box>
			)}
		</Box>
	);
};

/** 最终状态显示 */
const FinalStatus: React.FC<{
	status: TuiRendererState["finalStatus"];
	submitError: TuiRendererState["submitError"];
	terminationReason: TuiRendererState["terminationReason"];
}> = ({ status, submitError, terminationReason }) => {
	switch (status) {
		case "submit_accepted":
			return (
				<Box>
					<Text bold color="green">
						{" ✔ DONE "}
					</Text>
					<Text color="green">{" submit accepted"}</Text>
				</Box>
			);
		case "submit_rejected":
			return (
				<Box>
					<Text color="red">{"✗"}</Text>
					<Text>
						{` submit rejected (${submitError?.attempt}/${submitError?.maxAttempts}): `}
					</Text>
					<Text dimColor>{submitError?.error}</Text>
				</Box>
			);
		case "terminated":
			return (
				<Box>
					<Text color="yellow">{"!"}</Text>
					<Text dimColor>{` ${terminationReason}`}</Text>
				</Box>
			);
		case "aborted":
			return (
				<Box>
					<Text color="yellow">{"⚡"}</Text>
					<Text dimColor>{" 已中断输出"}</Text>
				</Box>
			);
		default:
			return null;
	}
};
