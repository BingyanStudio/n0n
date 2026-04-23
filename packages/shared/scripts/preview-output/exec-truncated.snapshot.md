# exec tool_result — status: truncated（输出超长截断）
<!-- model: claude-sonnet-4-20250514 -->

```
role: tool
toolCallId: tc_3
toolName: exec

--- content ---
<exec_meta>
(sh) . | exit 0 | 320ms | truncated to .temp/exec_output_tc_3.txt
</exec_meta>
<output>
... (last 4 of 850 lines)
./src/exec/executor.ts
./src/exec/security.ts
./src/types/domain.ts
</output>
<output_hint>
Full output (850 lines) saved to: .temp/exec_output_tc_3.txt

Or write a script to extract key information — do NOT type the full file.
</output_hint>
```
