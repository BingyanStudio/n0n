# Padding 工具设计

## 它是什么

一个在所有工具调用之后被调用的检查点工具。模型在其 `think` 参数中审视当前轮次是否还有可以一并发出的操作。

## 为什么需要它

### 主要作用：缓冲、出口、承载并行调用约束

我们的工具调用框架支持单轮多调用并行执行，也能自动识别依赖关系按序执行。这是一个比较宽松的效率约束——模型可以在一轮内尽量多地发出调用，框架负责处理。

但仅靠系统指令中的规则描述（"尽量多发调用"）来传达这个约束，效果不稳定。模型可能在发出一两个调用后就停止生成，遗漏本可以并行的操作。

Padding 工具将这个约束从一条需要记住的规则，变成了流程中的一个步骤：调用完其他工具后，调用 padding，在 think 中审视遗漏。类似铁路指差确认——价值在于强制执行检查这个动作本身，而不是检查带来的新信息。

### 次要作用：作为首个工具声明，提供多次调用的信号

Padding 工具排在工具列表的第一位。模型在解析工具定义时，首先看到的就是一个明确说"在其他工具调用之后调用我"的工具。这本身就是一个信号：这个工作流预期你会进行多次工具调用。

有了这个信号，系统指令中关于并行调用的较长段落可以精简或移除，由 padding 工具的存在和描述来承载。

## 工具定义

```json
{
  "name": "padding",
  "description": "调用其他工具后调用此工具。在 think 参数中说出当前轮次还能基于已有信息做什么，或确认没有遗漏。",
  "parameters": {
    "type": "object",
    "properties": {
      "think": {
        "type": "string",
        "description": "审视当前轮次：还有哪些不依赖未返回结果的操作可以一并发出？"
      }
    },
    "required": ["think"]
  }
}
```

## 约束

- 同一轮内 padding 不引入新信息。模型调用 padding 时尚未收到本轮其他调用的返回结果，反思只能基于已有上下文和已决定发出的调用。
- 每轮有固定 token 开销。简单任务不需要多工具调用时，padding 是额外成本。
- 存在退化为空仪式的风险。think 参数的 description 用具体问题（"哪些不依赖未返回结果的操作"）引导，而非开放式的"想想还能做什么"。

## 配套的系统指令调整

采用 padding 工具后，code.md `# Using your tools` 中以下内容可由 padding 承载，从系统指令中移除：

> Issue as many tool calls as possible in a single response turn. The only reason to wait is when you need information from a tool's return to decide what to do next. Independent calls go out in parallel; sequentially dependent calls (modify A → modify B → run test) also go out in one batch — the external system automatically identifies dependencies and executes them in the correct order with no race conditions. Even multiple operations on the same file can be issued at once. If you catch yourself issuing one tool call per turn, pause and use `reminder` to list all remaining tool calls, then issue them all in the next turn.

其中关于框架能力的部分（并行执行、依赖识别）仍需保留，但可以精简为一两句，不再需要长段落的行为规则。
