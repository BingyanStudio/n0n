# tool_arg_error 消息（含 schema）
<!-- model: claude-sonnet-4-20250514 -->

```
role: tool
toolCallId: tc_err
toolName: exec

--- content ---
<error>
Bad tool args — script: Required

Expected schema:
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string"
    }
  },
  "required": [
    "script"
  ]
}
</error>
```
