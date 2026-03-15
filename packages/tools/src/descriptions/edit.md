Edit a file using standard Vim ex commands. The file must already exist.
If you know Vim, you already know how to use this tool — `:s`, `:c`, `:d`, `:a`, `:i`, `:g` all work as expected.
Write vim_command as a multi-line string — each line is one ex command or content line.

<example>
**Replace a function body** — use `:c` (change) with pattern addressing:

vim_edit({ path: "src/auth.ts", vim_command: "/function validateToken/+1,/^}/-1c\n  const decoded = jwt.verify(token);\n  if (!decoded) throw new Error('invalid');\n  return decoded.userId;\n." })

`/pattern/+1` = line after match, `/^}/-1` = line before `}`.
`:c` replaces the addressed range. A single `.` on its own line terminates the input.
</example>

<example>
**Replace a markdown section:**

vim_edit({ path: "README.md", vim_command: "/## Installation/+1,/^##/-1c\nRun `npm install` to get started.\n\nSee [docs](./docs) for details.\n." })
</example>

<example>
**Append content after a line:**

vim_edit({ path: "src/app.tsx", vim_command: "/import.*react/a\nimport { useState } from 'react';\n." })
</example>

<example>
**Delete all lines matching a pattern:**

vim_edit({ path: "src/utils.ts", vim_command: "g/console\\.log/d" })
</example>

<example>
**Single-line substitution with `:s`** — given this line in the file:
`  status: isSuccess ? "completed" : "failed" as const,`

<bad_example>
Splitting `:s` across multiple lines — this will fail with E486/E492:

vim_edit({ path: "src/state.ts", vim_command: "/isSuccess ? \"completed\"/\ns/isSuccess ? \"completed\" : \"failed\" as const,/\n(isSuccess ? \"completed\" : \"failed\") as Status,/" })

Line 1 is just a search (no edit). Lines 2-3 are a broken `:s` — Vim's `:s/old/new/` is a single-line command, it cannot be split across lines.
</bad_example>

<good_example>
Use `:s` on one line — the entire `old/new` must be on the same line:

vim_edit({ path: "src/state.ts", vim_command: "%s/isSuccess ? \"completed\" : \"failed\" as const/(isSuccess ? \"completed\" : \"failed\") as Status/" })

Or use `:c` to replace the whole line (better when the line is complex):

vim_edit({ path: "src/state.ts", vim_command: "/isSuccess.*as const/c\n  status: (isSuccess ? \"completed\" : \"failed\") as Status,\n." })
</good_example>

</example>

<example>
**Example 6 — Pattern addressing with parentheses (vim regex ≠ JS regex):**

To replace a multi-line function call like `parseWorkspaceArg(\n\targs,\n\tprocess.cwd(),\n)`:

<bad_example>
Using JS-style regex escaping — `\(\)` means grouping in Vim, not literal parens:

vim_edit({ path: "src/index.ts", vim_command: "/parseWorkspaceArg($/,/process.cwd\\(\\),/-1c\n\tnewArg,\n." })

This fails with E486 because `\(\)` creates an empty capture group, not a literal `()`.
</bad_example>

<good_example>
In Vim, `(` and `)` are already literal — just use them directly:

vim_edit({ path: "src/index.ts", vim_command: "/parseWorkspaceArg($/,/process.cwd(),/-1c\n\tnewArg,\n." })
</good_example>
</example>

**Quick reference:**
  3d                 — delete line 3
  2,4d               — delete lines 2-4
  %s/old/new/g       — global search & replace
  /pattern/d         — delete line matching pattern
  /start/,/end/d     — delete range between patterns
  g/pattern/d        — delete ALL lines matching pattern

**Important:**
- Do NOT include `:wq` — it is added automatically.
- `:c`, `:a`, `:i` commands MUST end with a single `.` on its own line.
- Content lines inside `:c`/`:a`/`:i` must NOT be a lone `.` (it terminates input).
  If you need a literal `.` line, use `..` or a workaround.
- Multiple `/pattern/+offset,/pattern/-offset c` (offset-addressed change) commands
  in one call will silently fail after the first.
  **Workaround**: use `/start/,/end/c` without offsets (include boundary lines in
  replacement content), use absolute line numbers (edit bottom-to-top), or split
  into separate vim_edit() calls.
- **Vim regex is NOT JavaScript regex.** In Vim's default magic mode,
  `(` `)` are literal characters, `\(` `\)` are grouping.
  To match `process.cwd()`, use `/process.cwd()/` — do NOT escape the parentheses.
  Only `.` `*` `[` `^` `$` `~` have special meaning; everything else is literal.
- Pattern addresses match the **first** occurrence from the current position.
  When a file has similar/repeated patterns (e.g. multiple functions with `}`),
  include enough context in your pattern to ensure a unique match.
  For example, use `/function specificName/` instead of just `/function/`.
- **Edits are atomic**: if ANY command fails or is skipped (e.g. pattern not found),
  the entire edit is rolled back. Fix all patterns and retry.
