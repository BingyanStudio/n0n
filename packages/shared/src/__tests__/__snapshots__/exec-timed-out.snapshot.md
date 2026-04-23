# exec tool_result — status: timed_out（等待超限转后台）
<!-- model: claude-sonnet-4-20250514 -->

```
role: tool
toolCallId: tc_4
toolName: exec

--- content ---
<exec_meta>
(unknown) . | timed out | 30003ms
</exec_meta>
<waitfor_notice>
Process exceeded waitfor limit, moved to background.
PID: 65432
Log file: .temp/exec_bg_65432.log
Read the log file later to check process status.
</waitfor_notice>
<output>
npm warn deprecated inflight@1.0.6
added 142 packages in 28s
</output>
```
