# assistant_tool_call 消息
<!-- model: claude-sonnet-4-20250514 -->

```
role: assistant
toolCalls: [
  {
    "id": "tc_1",
    "tool": "exec",
    "args": {
      "script": "cat src/auth.ts"
    }
  },
  {
    "id": "tc_2",
    "tool": "write",
    "args": {
      "path": "test.txt",
      "content": "hi"
    }
  }
]

--- content ---
Let me read the file.
```
