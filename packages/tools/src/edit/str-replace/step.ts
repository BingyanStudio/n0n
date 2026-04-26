/**
 * EditorStep — 编辑器循环的单步无副作用执行
 *
 * 职责：从当前状态出发，执行一轮 LLM 调用，返回所有可观测信息。
 * 不管理循环状态，不修改外部状态。
 */

import type { DomainMessage, LLMClient, StreamEvent, TokenUsage } from "@n0n/types";
import { StreamAccumulator } from "@n0n/types";
import { EDITOR_TOOLS } from "./tools.ts";
import prompt from "./prompt.md" with { type: "text" };

export const MAX_ROUNDS = 15;

// ── 类型 ──

// ── 内部独立工具函数（无外部依赖） ──

export function countOccurrences(text: string, pattern: string): number {
  if (pattern.length === 0) return 0;
  let count = 0;
  let pos = text.indexOf(pattern, 0);
  while (pos !== -1) {
    count++;
    pos = text.indexOf(pattern, pos + pattern.length);
  }
  return count;
}

/**
 * 应用单次 search/replace 操作。
 * 归一化 CRLF 换行符，确保 LLM 生成的 \n 能匹配源文件的 \r\n。
 */
export function applySingleOp(
  source: string,
  oldStr: string,
  newStr: string,
  expectedMatches = 1,
): { ok: true; content: string } | { ok: false; error: string } {
  const useCrlf = source.includes("\r\n");
  const normSource = useCrlf ? source.replace(/\r\n/g, "\n") : source;
  const normOld = oldStr.replace(/\r\n/g, "\n");

  const actualMatches = countOccurrences(normSource, normOld);

  if (actualMatches !== expectedMatches) {
    const preview = normOld.length > 80 ? `${normOld.slice(0, 80)}...` : normOld;
    if (actualMatches === 0) {
      return { ok: false, error: `Search text not found: "${preview}" — actual matches: 0, expected matches: ${expectedMatches}. Rejected. Please fix expected_matches or provide more context in old_string for precise matching.` };
    }
    return { ok: false, error: `Match count mismatch for "${preview}" — actual matches: ${actualMatches}, expected matches: ${expectedMatches}. Rejected. Please fix expected_matches or provide more context in old_string for precise matching.` };
  }

  const normNew = useCrlf ? newStr.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : newStr.replace(/\r\n/g, "\n");
  const content = normSource.split(normOld).join(normNew);
  return { ok: true, content: useCrlf ? content : content };
}

export function getReplacementContext(content: string, newStr: string, contextLines = 2): string {
  if (!newStr) return "(deletion — no replacement context)";
  const pos = content.indexOf(newStr);
  if (pos === -1) return "";
  const lines = content.split("\n");
  const linesBefore = content.slice(0, pos).split("\n");
  const replacementStartLine = linesBefore.length;
  const replacementLines = newStr.split("\n").length;
  const start = Math.max(0, replacementStartLine - contextLines - 1);
  const end = Math.min(lines.length, replacementStartLine + replacementLines + contextLines);
  const numbered = lines.slice(start, end).map((line, i) => `${start + i + 1}| ${line}`).join("\n");
  return `Context (L${start + 1}-${end}):\n${numbered}`;
}

/**
 * 根据当前编辑状态生成引导消息
 * - 编辑完成 & 检查过 → submit
 * - 编辑完成 & 没检查 → view_file
 * - 编辑未完成 → str_replace
 */
function getGuidanceMessage(currentContent: string, originalSource: string): string {
  const contentChanged = currentContent !== originalSource;
  if (contentChanged) {
    return [
      "Thank you for your response. To proceed:",
      "- If you believe the edits are complete and correct, call **submit** with scored feedback.",
      "- If you want to verify the results first, call **view_file** to check the current file content.",
      "- If more changes are needed, call **str_replace** to apply additional edits.",
    ].join("\n");
  }
  return [
    "Please use the available tools to implement the edit.",
    "Call **str_replace** with the exact text to find and the replacement text.",
    "After all replacements, call **view_file** to verify.",
    "When the result looks correct, call **submit** with scored feedback.",
    "If the intent is impossible to execute, call **submit** with a score of 0/4 explaining why.",
  ].join("\n");
}

export interface StepInput {
  /** 当前对话消息历史 */
  messages: DomainMessage[];
  /** 当前文件内容（已应用之前轮次编辑） */
  content: string;
  /** LLM Client */
  client: LLMClient;
  /** 当前轮次编号（0-based） */
  round: number;
  /** 当前已累计的编辑次数 */
  editCount: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 事件回调 */
  onEvent?: (round: number, event: StreamEvent) => void;
  /** 工具结果回调 */
  onToolResult?: (round: number, summary: string) => void;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StepResult {
  /** 更新后的消息历史（追加了本轮 assistant + 所有 tool_results） */
  messages: DomainMessage[];
  /** 更新后的文件内容 */
  content: string;
  /** 本轮调用的工具列表 */
  toolCalls: ToolCallInfo[];
  /** 本轮完成的编辑次数（增量） */
  editCountDelta: number;
  /** 累计编辑次数 */
  totalEditCount: number;
  /** token 用量 */
  tokenUsage: TokenUsage | null;
  /** 完成原因 */
  finishReason: string | null;
  /** 是否提交（调用 submit 工具） */
  hasSubmit: boolean;
  /** submit 反馈 */
  feedback: string | null;
  /** 是否出错 */
  error?: string;
  /** 本轮未产生工具调用，需要外部引导下一轮工具调用 */
  needsGuidance?: boolean;
  /** 助手消息的原始文本内容 */
  assistantContent: string | null;
  /** 思考内容 */
  reasoning: string | null;
}

// ── 辅助函数 ──

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  value: string,
): DomainMessage {
  return {
    type: "generic_tool_result",
    callId: toolCallId,
    toolName,
    content: value,
  };
}

// ── 单步执行 ──

export async function editorStep(input: StepInput): Promise<StepResult> {
  const { messages, content, client, round, signal, onEvent, onToolResult } = input;
  let current = content;
  let editCountDelta = 0;

  if (signal?.aborted) {
    return {
      messages,
      content: current,
      toolCalls: [],
      editCountDelta: 0,
      totalEditCount: input.editCount,
      tokenUsage: null,
      finishReason: null,
      hasSubmit: false,
      feedback: null,
      error: "Aborted",
      assistantContent: null,
      reasoning: null,
    };
  }

  // ── 1. LLM 调用 ──

  const acc = new StreamAccumulator();
  let message: ReturnType<StreamAccumulator["toMessage"]>;

  try {
    for await (const event of client.stream(
      { messages, tools: EDITOR_TOOLS, toolChoice: "auto" },
      signal,
    )) {
      acc.push(event);
      onEvent?.(round, event);
    }
    message = acc.toMessage();
  } catch (err) {
    return {
      messages,
      content: current,
      toolCalls: [],
      editCountDelta: 0,
      totalEditCount: input.editCount,
      tokenUsage: null,
      finishReason: null,
      hasSubmit: false,
      feedback: null,
      error: `Editor LLM error: ${err instanceof Error ? err.message : String(err)}`,
      assistantContent: null,
      reasoning: null,
    };
  }

  const tokenUsage = acc.usage;
  const finishReason = acc.finishReason;

  // ── 2. 检查工具调用 ──

  if (message.toolCalls.length === 0) {
    // 没有工具调用：注入引导消息，让外部 loop 重试
    const guidance = getGuidanceMessage(current, input.content);
    messages.push({
      type: "generic_user_text",
      content: guidance,
    });
    return {
      messages,
      content: current,
      toolCalls: [],
      editCountDelta: 0,
      totalEditCount: input.editCount,
      tokenUsage,
      finishReason,
      hasSubmit: false,
      feedback: null,
      error: undefined,
      needsGuidance: true,
      assistantContent: message.content,
      reasoning: message.reasoningText,
    };
  }

  // ── 3. 解析工具调用参数 ──

  const parsedToolCalls: Array<{
    tc: (typeof message.toolCalls)[number];
    args: Record<string, unknown> | null;
  }> = message.toolCalls.map((tc) => {
    try {
      return { tc, args: JSON.parse(tc.input) as Record<string, unknown> };
    } catch {
      return { tc, args: null };
    }
  });

  // 构建 assistant 消息
  messages.push({
    type: "generic_tool_call",
    content: message.content ?? "",
    toolCalls: parsedToolCalls
      .filter((p) => p.args !== null)
      .map((p) => ({
        id: p.tc.toolCallId,
        tool: p.tc.toolName,
        args: p.args!,
      })),
  });

  // ── 4. 执行工具调用 ──

  const toolCalls: ToolCallInfo[] = [];
  let hasSubmit = false;
  let feedback: string | null = null;

  for (const { tc, args } of parsedToolCalls) {
    const name = tc.toolName;

    if (args === null) {
      messages.push(
        toolResultMessage(tc.toolCallId, name, "Error: Failed to parse tool arguments as JSON."),
      );
      onToolResult?.(round, "parse error");
      toolCalls.push({ id: tc.toolCallId, name, args: {} });
      continue;
    }

    toolCalls.push({ id: tc.toolCallId, name, args });

    switch (name) {
      case "str_replace": {
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        const expectedMatches = typeof args.expected_matches === "number" ? args.expected_matches : 1;

        if (!oldStr) {
          messages.push(toolResultMessage(tc.toolCallId, name, "Error: old_string cannot be empty."));
          onToolResult?.(round, "str_replace → old_string empty");
          break;
        }

        const result = applySingleOp(current, oldStr, newStr, expectedMatches);
        if (result.ok) {
          current = result.content;
          editCountDelta++;
          const context = getReplacementContext(current, newStr);
          messages.push(toolResultMessage(tc.toolCallId, name, `OK: Replacement applied (edit #${input.editCount + editCountDelta}).\n${context}`));
          const oldLines = oldStr.split("\n").length;
          const newLines = newStr.split("\n").length;
          const addedLines = Math.max(0, newLines - oldLines);
          const removedLines = Math.max(0, oldLines - newLines);
          const lineStats = [removedLines > 0 ? `-${removedLines}` : null, addedLines > 0 ? `+${addedLines}` : null].filter(Boolean).join(" ") || "±0";
          onToolResult?.(round, `str_replace → edit #${input.editCount + editCountDelta} (${lineStats} lines)`);
        } else {
          messages.push(toolResultMessage(tc.toolCallId, name, [`Error: ${result.error}`, "", "Check whitespace, indentation, and character-for-character accuracy.", "Call view_file to see the current file content."].join("\n")));
          onToolResult?.(round, `str_replace → ${result.error}`);
        }
        break;
      }

      case "view_file": {
        const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
        const endLine = typeof args.end_line === "number" ? args.end_line : undefined;
        const lines = current.split("\n");

        if (startLine !== undefined || endLine !== undefined) {
          const start = Math.max(1, startLine ?? 1);
          const end = Math.min(lines.length, endLine ?? lines.length);
          if (start > end) {
            messages.push(toolResultMessage(tc.toolCallId, name, `Error: Invalid line range: start_line (${start}) > end_line (${end}).`));
            onToolResult?.(round, "view_file → invalid range");
            break;
          }
          const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}| ${line}`).join("\n");
          messages.push(toolResultMessage(tc.toolCallId, name, `<source_file lines="${start}-${end}" total="${lines.length}">\n${numbered}\n</source_file>`));
          onToolResult?.(round, `view_file → L${start}-${end} (${end - start + 1} lines)`);
        } else {
          messages.push(toolResultMessage(tc.toolCallId, name, `<source_file>\n${current}\n</source_file>`));
          onToolResult?.(round, `view_file → ok (${lines.length} lines)`);
        }
        break;
      }

      case "submit": {
        feedback = typeof args.feedback === "string" && args.feedback.length > 0 ? args.feedback : null;
        hasSubmit = true;
        onToolResult?.(round, feedback ? `submit\n  ${feedback}` : "submit");
        break;
      }

      default: {
        messages.push(toolResultMessage(tc.toolCallId, name, `Error: Unknown tool "${name}". Use str_replace, view_file, or submit.`));
        onToolResult?.(round, `unknown tool: ${name}`);
      }
    }
  }

  return {
    messages,
    content: current,
    toolCalls,
    editCountDelta,
    totalEditCount: input.editCount + editCountDelta,
    tokenUsage,
    finishReason,
    hasSubmit,
    feedback,
    error: undefined,
    assistantContent: message.content,
    reasoning: message.reasoningText,
  };
}

/**
 * 创建初始对话消息（system prompt + user message）
 */
export function createInitialMessages(source: string, intent: string): DomainMessage[] {
  return [
    { type: "system", content: prompt },
    {
      type: "generic_user_text",
      content: [
        "<source_file>",
        source,
        "</source_file>",
        "",
        "<edit_intent>",
        intent,
        "</edit_intent>",
        "",
        "The content inside <source_file>...</source_file> is the original file to be modified.",
        "The content inside <edit_intent>...</edit_intent> is the edit request you need to implement.",
        "Use str_replace to apply changes, view_file to verify the result, and submit to finish.",
        "If the intent is impossible to execute, call submit with a score of 0/4 explaining why.",
      ].join("\n"),
    },
  ];
}
