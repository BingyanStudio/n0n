## 命题题面

自然语言驱动的工作流引擎

实现一个自主原创开发的工作流引擎（禁止基于任何已有的开源工作流引擎，可以理解为原创开发一个小型的n8n或Dify），最小可行产品功能包括：可支持Skills注册与组合，用户可通过自然语言交互让AI创建工作流，实现自动编排、执行多步骤任务流。

## 思路

我们做一些有意思的事情：

1. 我们不用传统的ui或者有向图的模式，我们直接使用 ts/js 代码作为workflow
2. 我们抽象一个 通用库 subagent，模型可以在代码里调用它，并且为它分配任务
3. 我们提供一个 creatTask 创建一个任务，内部实现是先通过我们的一套 workflow 先初始化增强，然后再丢给 subagent

## 我觉得现在没有理清的问题：

### 如何构建ai交互式脚本

对于普通流程来说：
- ai接收到要求
- ai通过 agent-loop 循环尝试编写代码解决问题
    - 运行代码
    - 代码报错返回
- 进一步修改

但是如果这里面有ai的参与
- ai接收到要求
- ai通过 agent-loop 循环尝试编写代码解决问题（代码里包含subagent）
    - 运行代码（这里实际上已经是包含ai步骤的工作流）
    - subagent 被拉起 jump 到 A
    - 代码报错（agent报错）返回
- 修改提示词或者其他部分，再次运行



A：
- subagent 接收到要求
- ai通过 agent-loop 循环尝试解决问题
- 发现行不通：调用 error 工具返回错误。


## 使用场景构想

### 定时任务

> 这意味着需要有一个注册定时（周期/非周期）任务的工具

需要一个**定时触发器（scheduler）**：常驻进程，根据注册的 cron 表达式或一次性时间点，到时拉起 `delegateTask` 调用流程。本质上是一个持久化的任务调度表 + 触发循环。

### 跨任务上下文

> 执行任务时，希望它能够记得我之前的偏好。我认为可以通过workflow-agent / rag 来做，这也是为什么我们的 createTask 需要有前置的 workflow 步骤

### 定期反思

> 1. 所有的推理历史 / 以及产出的 worflow（ts/js 脚本）都会被review，并且提取可用信息放进记忆中

### 自我能力拓展

我的想法就是所有的 workflow 都类似于 monorepo，可以互相引用和调用。

至于如何发现能力，模型可以通过ls方法去做，以及每个monorepo都要求有一个readme，后续可以通过 createTask 的 workflow 步骤增强。

### skill 的注册和创建

和定期反思出来的记忆的处理路径基本一致，但是skill产出的内容优先级更高。

## 技术简要决策

### subagnt 工具

我们不提供工具注册手段。每个agent都只有最基础的工具：
1. exec 执行命令，参数：
    - 命令内容
    - ？执行位置，默认为项目根目录
    - ？等待执行时长（默认为 2min，即使调用执行没结束也继续执行循环）
2. write 写入，参数：
    - path
    - ？search （若不提供或者为空，则视为完整写入）
    - replace
    - ？expectedReplaceTime（默认为1，也即search精准匹配，和期望不符合会返回工具错误
3. read-media 读取图片，参数：
    - path
    - focusX
    - focusY
    - scale
4. reminder 为自己设置提醒，会在n轮后作为user消息插入
    - content
    - ？delay （n轮后插入，默认为7）
5. submit 交付需要的结果：
    - result 返回结果，一般为 `Result<T, E>` 若调用方没有要求结果，则可以是自然文本，若不符合要求，则会打回去重新调用
    - ？report 支持返回简明的汇报，调用方选择性处理

这应该能够为ai提供所有所需的能力

### task 库

#### subagent

调用方法：
```ts
async function subagent(history:DomainMessage[],schema?:ZodSchema): SubagentResult<T>
type SubagentResult<T> = {
    result: T,
    report: string,
    history: DomainMessage[]
}
```

#### ragsearch

调用方法：
```ts
async function ragSearch(query:string,space?:SearchSpace): RagSearchResult
type SearchSpace = "all" | "memory" | "skill" | "history"
```

#### task

调用方法：
```ts
async function delegateTask(query:string,schema?:ZodSchema): TaskResult<T>
type TaskResult<T> = {
    result: T,
    report: string,
    history: DomainMessage[]
}
```

在调用前我们会做：
1. 调用 subagent 发起一次咨询："我想要做xxx，我想要想你请教一下这件事情的最佳实践、以及可能会遇到的问题和解决办法，写入文档" 要求返回文档路径。
2. 使用 rag，对建议文档和问题查找（记忆、skill、history）所有相关的信息。其中匹配精准度逐渐提高（以为history噪声高）
3. 组装所有的内容，提交为一次 subagent

#### DomainMessage

标准领域设计规范，内部只记录数据，具体提示词转换由统一处理负责，同时能够避免：cot过长；toolcall、toolresult不匹配；提示词缓存性能下降。