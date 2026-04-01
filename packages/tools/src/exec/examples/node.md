- `node` (Node.js, .mjs): JS runtime, similar to bun
  ```
  import { readdir } from "node:fs/promises";
  const files = await readdir("./src", { recursive: true });
  console.log(files.length + ' files found');
  ```
