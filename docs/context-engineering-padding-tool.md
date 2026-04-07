# Think 工具设计

（原名 padding，因名称暗示"填充物"导致模型将其视为无意义占位，改名为 think。）

## 它是什么

一个穿插在工具调用之间的思考检查点。模型在其 `content` 参数中审视当前响应是否还有可以一并发出的操作，然后继续生成更多调用。

## 为什么需要它

### 主要作用：将并行调用约束从规则变为流程步骤

我们的工具调用框架支持单轮多调用并行执行，也能自动识别依赖关系按序执行。但仅靠系统指令中的规则描述来传达这个约束，效果不稳定——模型可能在发出一两个调用后就停止生成。

Think 工具将这个约束从一条需要记住的规则，变成了生成流程中的一个步骤：调用 write/edit 后，调用 think 审视遗漏，然后继续追加调用。价值在于生成时的自我检查动作本身。

### 次要作用：作为首个工具声明，提供多次调用的信号

Think 工具排在工具列表的第一位。模型解析工具定义时，首先看到的就是一个明确说"在工具调用之间思考"的工具，这本身就是一个"本工作流预期多次调用"的信号。

## 工具定义

```json
{
  "name": "think",
  "description": "Use this tool to think between tool calls. In `content`, review what other operations you can issue in the current response.\n\nwrite and edit always succeed — treat their results as available immediately.\nAfter calling them, call think to decide what to do next, then issue those calls — all in the same response.\nOnly stop and wait when you genuinely need a tool's output (e.g. exec) to decide what to do next.",
  "parameters": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "Your thinking: what other operations can you issue now that don't depend on pending results?"
      }
    },
    "required": ["content"]
  }
}
```

## 描述措辞的关键设计决策

旧版描述（padding）说"Call this after your other tool calls"，"after"暗示终止，导致模型把它当作一轮的最后一步。新版描述改为"between tool calls"，明确这是中间环节而非收尾动作。

## 约束

- 同一轮内 think 不引入新信息。模型调用 think 时尚未收到本轮其他调用的返回结果，反思只能基于已有上下文。
- 每轮有固定 token 开销。简单任务不需要多工具调用时，think 是额外成本。
- 存在退化为空仪式的风险。content 参数的 description 用具体问题引导，而非开放式的"想想还能做什么"。
