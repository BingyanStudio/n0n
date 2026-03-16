Edit a file by describing your modification intent. The file must already exist.

Express what you want to change in natural language, code snippets, or a mix of both. An editor agent will interpret your intent and apply the changes precisely.

## How to use

The `intent` parameter accepts free-form text. You can:

- **Describe in natural language**: "Change the timeout from 15000 to 30000"
- **Provide code snippets**: "Replace the validateUser function with:\n```\nfunction validateUser(u: User): boolean {\n  return u.name.length > 0;\n}\n```"
- **Mix both**: "Add error handling to the database query in fetchUsers — wrap it in try/catch and return null on failure"
- **Batch changes**: "1. Rename all occurrences of oldName to newName\n2. Add a timeout parameter to the connect function\n3. Remove the deprecated logLevel import"

## Examples

**Simple value change:**
```
edit({ path: "src/config.ts", intent: "Change TIMEOUT from 5000 to 10000" })
```

**Function rewrite:**
```
edit({ path: "src/auth.ts", intent: "Replace the validateToken function with:\nfunction validateToken(token: string): boolean {\n  const decoded = jwt.verify(token, SECRET);\n  return !!decoded;\n}" })
```

**Structural change:**
```
edit({ path: "src/api.ts", intent: "Add a retry loop (max 3 attempts) around the fetch call in sendRequest" })
```

## Tips

- Be specific about **what** to change and **where** (function name, variable name, etc.)
- When providing replacement code, include the complete new version
- For small changes, natural language is often more concise
- For large rewrites, providing the full new code is more reliable
