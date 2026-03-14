/**
 * InputBox — 用户输入组件
 *
 * 支持多行输入（Shift+Enter 换行，Enter 发送）。
 * 解决 readline 无法处理换行输入的问题。
 */

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

interface InputBoxProps {
	/** 提示符文本 */
	prompt?: string;
	/** 提交回调 */
	onSubmit: (text: string) => void;
	/** 是否禁用输入 */
	disabled?: boolean;
	/** 是否显示 */
	visible?: boolean;
}

export const InputBox: React.FC<InputBoxProps> = ({
	prompt = "USER",
	onSubmit,
	disabled = false,
	visible = true,
}) => {
	const [input, setInput] = useState("");
	const [isMultiline, setIsMultiline] = useState(false);

	// 处理键盘输入
	useInput(
		(inputChar, key) => {
			if (disabled) return;

			// Ctrl+C - 清空当前输入
			if (key.ctrl && inputChar === "c") {
				setInput("");
				setIsMultiline(false);
				return;
			}

			// Enter 键处理
			if (key.return) {
				// Shift+Enter = 换行
				if (key.shift) {
					setInput((prev) => `${prev}\n`);
					setIsMultiline(true);
					return;
				}

				// 普通 Enter = 提交（如果有内容）
				if (input.trim()) {
					onSubmit(input);
					setInput("");
					setIsMultiline(false);
				}
				return;
			}

			// Backspace
			if (key.backspace || key.delete) {
				setInput((prev) => prev.slice(0, -1));
				if (input.length <= 1) {
					setIsMultiline(false);
				}
				return;
			}

			// 普通字符输入
			setInput((prev) => prev + inputChar);
		},
		{ isActive: visible && !disabled },
	);

	if (!visible) return null;

	// 格式化显示输入内容
	const displayLines = input.split("\n");
	const showCursor = !disabled;

	return (
		<Box flexDirection="column" marginTop={1}>
			{/* 提示符 */}
			<Box>
				<Text bold color="green">
					{` ${prompt} `}
				</Text>
				{isMultiline && (
					<Text dimColor>{" (多行模式, Shift+Enter 换行, Enter 发送)"}</Text>
				)}
			</Box>

			{/* 输入区域 */}
			<Box marginLeft={2} flexDirection="column">
				{displayLines.map((line, i) => (
					<Box key={`line-${i}-${line.slice(0, 10)}`}>
						{isMultiline && i > 0 && <Text dimColor>{"  "}</Text>}
						<Text>{line}</Text>
						{showCursor && i === displayLines.length - 1 && (
							<Text backgroundColor="white" color="black">
								{" "}
							</Text>
						)}
					</Box>
				))}
				{input === "" && showCursor && (
					<Text backgroundColor="white" color="black">
						{" "}
					</Text>
				)}
			</Box>

			{/* 帮助提示 */}
			{input === "" && !disabled && (
				<Box marginLeft={2}>
					<Text dimColor>{"输入消息，Enter 发送，Shift+Enter 换行"}</Text>
				</Box>
			)}

			{/* 禁用状态提示 */}
			{disabled && (
				<Box marginLeft={2}>
					<Text dimColor>{"模型正在输出..."}</Text>
				</Box>
			)}
		</Box>
	);
};
