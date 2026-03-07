# 2026.03.06

## quote

```
既然如此，我想要试试看一种新的提示词构建方式：

让模型答题，而不考虑身份、不考虑思考。

整个提示词结构为（只有一个 system、一个 user消息）：

system
【核心背景】
【工具说明】
【简单约束】
【设定文档】

user
【已有剧本】
【补全引子】
【工具提示】

---
模型不再是剧本中的任务，也不是写这个剧情的人，而是 这本剧本是一个杰出的小说家写的小说 **这是一个已经有完整剧情的小说的一部分** ，模型需要做的是通过推理和判断，**通过推理猜测** 这个部分的剧情应该是什么。

---
其中用户输入不再是作为 角色所想，也不是进入叙事，而是给这个模型（做题家），提供的提示：提示，但是故事中的 他 正在想xxx。

---
提示词方面，我们不再引导你是谁、你应该如何思考，仅仅需要演示工具调用。其他的 风格什么的，作为题设背景提供。

---
工具仍然不变，分为action、dialogue和wait。但是工具的定位变为 “提交你的推理结果的工具”

---
请你开一个分支，我们来试试看这个想法。注意使用git做好版本管理。
```

## design

上面是另外一个项目的实践经验，，实验结果证明，效果**非常好**。

这里的核心优势有两点：
1. 不再指导模型做什么
2. 从最终目标上对齐（比如上面就是对齐一个已经存在了的小说）
3. 让模型从问题解决思维转向回答bench的答题思维，激发更深度的思考。

## QA

我已经理解了你的核心思路和现有系统。在动手之前，有几个关键设计决策需要对齐：

### **Q1: "已经存在的完整作品" 在这个场景下是什么？**

在你的 RP 项目里，对齐目标是"一本已经写好的小说"。但 n0n 的 interactive agent 是一个 workflow builder——它的"已经存在的完整作品"应该是什么？

我的理解是：**一个已经完成的、能正常运行的 workflow 项目**。模型不是"在创建 workflow"，而是"这个 workflow 已经被一个优秀的工程师写好了，你需要推理出它应该是什么样的"。对吗？

> A1: 假设用户已经有一个完整的图景、和一个已经完成的、能正常运行、高质量的、完美符合用户图景的 workflow 项目。比如用户说给一个早晨问候，应当思考是否要配图、是否应该获取天气和从memory中拿到更多信息，然后调用 llm生成一个得体的早晨问候。

### **Q2: user 消息的定位变化**

原来 user 消息 = 用户的需求指令。新范式下，user 消息 = "提示/线索"。在 RP 场景里这是"故事中的他正在想xxx"。在 workflow 场景里，这个"提示"应该怎么框定？比如："用户描述了一个需求，这是对这个已完成 workflow 的功能描述"？

A2: 包装为“用户透露了一个设计细节” 大概这种感觉。

### **Q3: 工具说明的简化程度**

你说"不再引导你是谁、你应该如何思考，仅仅需要演示工具调用"。现有 prompt 里有大量的规则（PLANNING MANDATORY、EFFICIENCY、delegateTask schema 用法等）。这些是全部砍掉只留工具签名演示，还是保留部分作为"题设背景"？

A3: 作为题设背景。

明白了，核心思路非常清晰。再确认最后两个细节：

### **Q4: paraphrase-in 协议保留吗？**

现有 prompt 里有一个 `<user paraphrase-in="en,ja">` 的多语言复述协议。新范式下这个还要吗？它本质上是一种"强制思考"机制，但你说"不考虑思考"——是砍掉，还是作为题设的一部分保留？

> A4 paraphrase是为了强化思考，但是这里我们通过“做题”的氛围补全了思考的必要。所以这个协议可以砍掉了。

### **Q5: 设定文档的范围**

你提到 system 结构是 `【核心背景】【工具说明】【简单约束】【设定文档】`。在 n0n 场景下：
- **核心背景** = "这是一个已完成的优秀 workflow 项目，你需要推理出每一步"
- **工具说明** = exec/write/edit/reminder/submit 的签名演示
- **简单约束** = 安全规则（不用 sudo 等）
- **设定文档** = ?

设定文档应该包含什么？是现有的 Output format（workflow 文件结构、delegateTask 用法、skills 目录规范等）作为"这个项目的技术规范"提供？还是你有其他想法？

> A5 设定文档就是现有技术规范，可能需要加一个最佳示例用以提供指导。

## 实践时追加的patch：

### user 消息包装

包装user消息为：

```markdown
<hint>
用户的原话
</hint>

First, ask yourself: can I answer this by calling `exec`, `write`, or `edit`? If yes — do it, then submit as `completed`.
If this is a pure social greeting with nothing actionable (e.g. 你好, 谢谢), submit a `chat` response.
Otherwise, the engineer has already built the perfect workflow for this.
Reason out what it looks like — start by calling `reminder` with your OKR breakdown,
then proceed step by step.
```

# 2026.03.07

## 问题：模型过早放弃，不尝试就说"做不到"

**现象**：用户问"现在几点？"，模型直接以 `chat` 回复"我是自动化助手，无法获取本地时间"，而不是调用 `exec({ script: "date" })`。

**根因**：
1. submit 的 `chat` 类型定义过宽，模型太容易落入"闲聊回复"分支
2. user 消息包装中 "If this is a simple greeting or casual chat" 排在第一位，优先引导了 chat 路径
3. 缺少持续的外部评估压力，模型没有动力去深度思考

## 设计决策

### 1. "Always Attempt" 原则

融入 Background 而非独立章节。核心表述：

> The engineer found a way — so can you. There is no request that "cannot be done."

不作为规则强制，而是作为"做题"心智模型的自然延伸——既然参考答案存在，那就一定有解法。

### 2. 外部评估压力

在 Background 中增加评分对齐机制：

> **Your submission will be evaluated against the hidden reference implementation.** At every step, ask yourself: *"What would the engineer have done here?"*

这段话的三重作用：
- **持续压力**：不是提交时才评分，而是"每一步"都在被比对
- **导向深度推理**：迫使模型在每个决策点思考 skilled engineer 的做法
- **排斥浅层捷径**：明确列出三种选择（shallow shortcut / lazy fallback / thoughtful solution），暗示前两种会被扣分

### 3. submit 类型收窄

| 类型 | 修改前 | 修改后 |
|------|--------|--------|
| **chat** | "casual conversation, simple greetings, or brief answers" | "Pure social exchange with zero actionable component" |
| **error** | "something went wrong that you cannot resolve" | "3 distinct approaches have all failed, with evidence of each attempt" |
| **completed** | 仅用于 workflow 文件 | 扩展为任何工具产出的结果（命令输出、计算答案等） |

### 4. 示例格式规范

使用 XML 标签包裹示例，正反对比：

```xml
<example>
User: "现在几点？"

<bad_example>
submit({ type: "chat", message: "我是自动化助手，无法获取本地时间。" })
</bad_example>

<good_example>
exec({ script: "date" })
submit({ type: "completed", result: "当前时间是 2026-03-07 15:00:00 CST" })
</good_example>
</example>
```

### 5. prompt 结构对齐

最终结构严格遵循设计文档的四段式，加一个示例段：

```
Background    → 核心背景 + 评估压力 + always attempt
Tools         → exec / write / edit / reminder / submit 签名演示
Constraints   → 4 条简单规则
Specification → n0n 技术规范（workflow 格式、文件组织、运行时、AI API）
Examples      → <example> + <good_example> / <bad_example> 正反对比
```

### 6. hint wrapper 优先级调整

adapter.ts 中 user 消息的行为指引顺序从：
1. ~~chat 判断~~ → workflow 推理

改为：
1. **exec/write/edit 可解？** → completed
2. 纯社交？ → chat
3. 否则 → workflow 推理

# 2026.03.07-2

## 动态 XML Tag 风格切换

### 问题

不同 LLM 模型对 XML-like 标签的理解能力不同。使用模型训练时的原生标签风格可以获得更好的结构化理解效果。

### 各模型 Tag 风格

| 模型族 | 开标签 | 闭标签 | 示例 |
|--------|--------|--------|------|
| Deepseek | `<\|DSML\|tag>` | `<\|/DSML\|tag>` | `<\|DSML\|hint>内容<\|/DSML\|hint>` |
| GLM | `<tag>` | `</tag>` | `<hint>内容</hint>` |
| Minimax | `]~b]tag` | `[e~[` | `]~b]hint 内容 [e~[` |
| 默认 | `<tag>` | `</tag>` | 标准 XML 风格 |

### 实现方案

在 `@n0n/llm` 包新增 `tags.ts` 模块：

1. **`detectTagStyle(model)`** — 从 `LLM_MODEL` 字符串推断模型族
2. **`adaptTags(text)`** — 将文本中的标准 `<tag></tag>` 替换为当前模型的风格（GLM/default 不替换）
3. **`wrapTag(name, content)`** — 用当前模型风格包裹内容

### 应用点

- **system prompt**：`adapter.ts` 在转换 `system` 消息时调用 `adaptTags()` 处理 `interactive.md` 中的 XML 标签
- **hint 包装**：`adapter.ts` 在包装 `user_input` 时使用 `wrapTag("hint", content)` 替代硬编码的 `<hint>`

### 设计决策

- prompt 模板（`.md` 文件）始终使用标准 XML 风格编写，运行时由 adapter 层统一转换
- 这保持了模板的可读性，同时实现了对不同模型的适配
- `adaptTags` 使用正则 `<(\w+)>` 和 `</(\w+)>` 匹配，不会误伤 markdown 中的 HTML 标签（因为 prompt 中不使用 HTML）

### 统一消息结构为 XML + Markdown

adapter.ts 中所有消息类型统一使用 `wrapTag()` 划分内容边界：

| 消息类型 | 使用的标签 |
|----------|-----------|
| exec 结果 | `<exec_meta>`, `<stdout>`, `<stderr>` |
| write 结果 | `<write_result>` 或 `<error>` |
| edit 结果 | `<edit_result>` 或 `<error>` |
| reminder/submit 结果 | `<result>` |
| 空闲警告 | `<system_warning>` |
| 用户输入 | `<context>`, `<capabilities>`, `<hint>` |
| 轮次反馈 | `<feedback>` |
| 提醒触发 | `<reminder>` |
| 参数错误 | `<error>` + `<schema>` |
| 提交被拒 | `<rejected>` |

结构特点：
1. XML 标签仅作为内容边界标记，不做 XML 转义
2. 标签内部使用 Markdown 丰富表达（`**加粗**`、`` `代码` ``、列表等）
3. 所有标签通过 `wrapTag()` 生成，自动适配当前模型的 tag 风格

# 2026.03.07-2

当前各个工具的返回和上下文的组织较为松散，建议统一为 xml 和 mardown 混合的结构，结构特点：
1. 使用 xml like 标签明确区分不同类型的内容。
2. 使用 xml 内的文本不需要经过额外的格式化处理（比如xml转义），而是直接作为纯文本处理，闭合的前后tag仅仅是为了区分不同内容的边界，便于模型理解。
3. 在 xml 内部可以使用 markdown 来丰富文本的表达，比如强调、列表等。

xml tag 风格可以直接复用模型学习的 xml tag，不同模型使用不同的tag模式区分：


## Deepseek

<|DSML|tag> </|DSML|tag>

## GLM

<tag></tag>

## Minimax

- 开头：]~b]tag
- 结尾：[e~[

比如

```
]~b]tag
这是内容
[e~[
```

# 2026.03.07-3

## 工具拆分与 exec 增强

### 问题

1. **write 职责混淆**：原 `write` 通过 `search` 字段有无来区分"创建文件"和"修改文件"，模型需要阅读描述才能理解，字段名本身无法传达语义。
2. **exec 在 Windows 上不稳定**：cmd.exe 的引号剥离导致复杂命令（尤其 `bun -e` 带转义字符）频繁失败。
3. **exec 缺乏 Programmatic Tool Calling 潜力**：模型只能发送单行 shell 命令字符串，无法利用 pwsh/bun 等现代运行时的完整脚本能力。

### 设计决策

#### 1. write / edit 拆分

将原 `write` 的两种语义拆分为独立工具，模型仅通过字段名即可理解用法：

| 工具 | 参数 | 职责 |
|------|------|------|
| `write` | `path, content` | 创建/覆盖文件 |
| `edit` | `path, search, replace, expectedMatches?` | 精确修改已有文件内容 |

#### 2. exec 增强：script + runtime 模型

exec 从 `command` 字符串改为 `script + runtime` 模型：

```ts
exec({ script: "git status" })                    // 简单命令，默认平台 shell
exec({ script: "Get-Process | Where-Object ...", runtime: "pwsh" })  // PowerShell 脚本
exec({ script: "const x = await fetch(...)", runtime: "bun" })       // TypeScript 代码
```

**核心机制**：所有平台统一走"写临时文件 → 用指定 runtime 执行"路径，彻底消除 shell 引号转义问题。

**支持的 runtime**：
- Shell 类：`sh`, `bash`, `cmd`, `pwsh`（支持管道、条件等 shell 语法）
- 语言类：`bun`, `node`, `python`（支持 import、多行逻辑等）
- 默认：平台 shell（Windows: `cmd`, 其他: `sh`）

#### 3. exec 输出处理最佳实践

在 tool description 中引导模型在脚本内部处理输出，避免大量原始数据污染上下文：

> Best practice: process output INSIDE the script (grep, filter, summarize) and only print what you need.

这与 Programmatic Tool Calling 理念一致——中间数据不进入模型上下文，只有最终结果返回。

#### 4. Programmatic Tool Calling 潜力

新的 script+runtime 模型天然支持本地版 PTC：模型可以写一个完整的 bun/pwsh 脚本，在一次调用中完成多步操作（读文件 → 处理数据 → 输出摘要），而非多次 exec 往返。

### 最终工具集

| 工具 | 参数 | 说明 |
|------|------|------|
| `exec` | `script, runtime?, cwd?, timeout?` | 脚本执行 |
| `write` | `path, content` | 文件创建/覆盖 |
| `edit` | `path, search, replace, expectedMatches?` | 文件修改 |
| `reminder` | `content, delay?` | 延迟提醒（不变） |
| `submit` | `result, report?` 或 schema 展开 | 提交结果（不变） |