Edit a file by describing your modification intent. An editor agent interprets your intent and applies changes precisely.

This tool is deterministic and always succeeds — do not wait for its result. Continue issuing more tool calls in the same response.

## Examples

```
edit({ path: "src/config.ts", intent: "Change TIMEOUT from 5000 to 10000" })
```

```
edit({ path: "src/api.ts", intent: "Add a retry loop (max 3 attempts) around the fetch call in sendRequest" })
```

```
edit({ path: "src/auth.ts", intent: "Replace the validateToken function with:\nfunction validateToken(token: string): boolean {\n  const decoded = jwt.verify(token, SECRET);\n  return !!decoded;\n}" })
```

## Tips

- Describe **what** to change using semantic references (function names, variable names, etc.)
- For small changes, natural language is concise; for rewrites, provide the full new code
- The editor agent will give you feedback if your intent can be improved
