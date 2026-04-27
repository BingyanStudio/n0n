# CollectingTagAdapter — 控制性内容提取为 developer 消息

> 日期：2026-03-05

---

## 一、动机

当前所有控制性内容（hint、idle warning、submit rejected、turn feedback、reminder）都嵌在 user 或 tool 消息中。多轮对话后这些内容在历史中累积，既浪费 token 又可能干扰模型。

DeepSeek-V4 的 `developer` 角色天然适合承载这些内容：
- 高优先级（模型不会忽略）
- 一次性（`drop_thinking` 时被丢弃，旧的控制指令不残留）
- 不打断 user→assistant 的对话流

核心思路：让 TagAdapter 在 `wrapTag` 时拦截控制性 tag，返回空字符串，将内容存入 sideband。formatPrompt 调用完毕后，DeepSeekClient 从 sideband 取出内容，组装为 developer 消息。

---

## 二、Tag 分类

### A 类：整条消息都是控制性内容

这些 DomainMessage 类型在 formatPrompt 中生成一条独立的 user 消息，其全部内容都是控制性 tag 包裹的指令。

| DomainMessage 类型 | tag name | 处理方式 |
|---|---|---|
| `idle_nudge` | `system_warning` | 整条替换为 developer 消息 |
| `submit:rejected` | `submit_rejected` | 整条替换为 developer 消息 |
| `turn_feedback` | `turn_feedback` | 整条替换为 developer 消息 |
| `reminder:due` | `reminder` | 替换为 `latest_reminder` 角色消息 |

拦截后原 user 消息变为空字符串 → 在后处理中过滤掉空 user 消息。

### B 类：嵌在 user_input 中的控制性片段

| 片段 | tag name | 处理方式 |
|---|---|---|
| hint（行为引导） | `hint` | 从 user 消息中剥离，在 user 消息后追加 developer 消息 |

剥离后 user 消息只剩 context + 纯用户输入。

### C 类：嵌在 tool result 中的控制性片段

| 片段 | tag name | 来源 |
|---|---|---|
| edit_feedback | `edit_feedback` | edit tool result |
| diagnostic_hint | `diagnostic_hint` | exec tool result |
| output_hint | `output_hint` | exec tool result（截断读取建议） |

**v1 暂不处理**：这些信息量小且与 tool result 强关联，保留原样。如果要处理，需要在最后一条 tool result 之后插入合并的 developer 消息。

---

## 三、接口设计

```typescript
// TagAdapter 接口不变（纯净，所有 provider 共用）
interface TagAdapter {
  wrapTag(name: string, content: string): string;
  adaptTags(text: string): string;
}

// DeepSeek 内部扩展
interface CollectedDirective {
  tag: string;
  content: string;
}

interface CollectingTagAdapter extends TagAdapter {
  /** 取出并清空收集到的控制性内容 */
  flush(): CollectedDirective[];
}
```

`CollectingTagAdapter` 不暴露在 `@n0n/types` 中——它是 `deepseek-client.ts` 的内部实现。

---

## 四、数据流

```
DeepSeekClient.stream():
  1. const adapter = createDeepSeekCollectingAdapter();  // 每次新建
  2. const promptMessages = formatPrompt(messages, adapter);
     → format-*.ts 调用 adapter.wrapTag(name, content)
     → 控制性 tag 被拦截：返回 ""，存入 adapter.collected
     → A 类消息的 content 变为空字符串
     → B 类消息的 content 去掉了 hint 部分
  3. const directives = adapter.flush();
  4. 后处理 promptMessages：
     a. 过滤空 user 消息
     b. 将 directives 按位置插入为 developer 消息
     c. 将 reminder 相关的 directive 转为 latest_reminder role
  5. 编码发送
```

### 消息结构变化示例

**user_input + hint（B 类）**

```
当前：
  { role: "user", content: "<context>...</context>\n\n用户问题\n\n<hint>行为指令</hint>" }

改造后：
  { role: "user", content: "<｜DSML｜context>...</｜DSML｜context>\n\n用户问题" }
  { role: "developer", content: "行为指令" }
```

**idle_nudge（A 类）**

```
当前：
  { role: "user", content: "<system_warning>你在空转...</system_warning>" }

改造后：
  { role: "developer", content: "你在空转..." }
```

**reminder:due（A 类 → latest_reminder）**

```
当前：
  { role: "user", content: "<reminder>提醒内容...</reminder>" }

改造后：
  { role: "latest_reminder", content: "提醒内容..." }
```

---

## 五、对 PromptMessage 的影响

当前 PromptMessage 只有 system/user/assistant/tool 四种 role。DeepSeek Client 需要在 `toDeepSeekMessages()` 中支持 developer 和 latest_reminder role。

两种路径：
1. **扩展 PromptMessage**：新增 `developer` 和 `latest_reminder` role → 影响所有 provider（其他 provider 忽略这两种 role）
2. **DeepSeek 内部类型**：后处理在 `promptMessages → DeepSeekMessage` 转换中完成，不改 PromptMessage

推荐路径 2：保持 PromptMessage 纯净，DeepSeek 的特殊消息类型在 Client 内部处理。

---

## 六、drop_thinking 的协同效果

DeepSeek-V4 的 `_drop_thinking_messages` 中，developer 不在 `keep_roles` 里 → 位于 `last_user_idx` 之前的 developer 消息被丢弃。

这意味着：
- 第 N 轮的 hint/warning/feedback 在第 N+1 轮被自动清理
- 上下文历史中只保留数据性内容（用户输入、工具结果、模型回复）
- 控制性内容只在当轮有效，不会无限累积

这正是我们想要的效果——"上下文的历史会更干净"。
