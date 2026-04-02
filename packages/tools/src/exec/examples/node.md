### `node` (Node.js, .mjs): JS runtime, similar to bun
```
import { readdir } from "node:fs/promises";
const files = await readdir("./src", { recursive: true });
console.log(files.length + ' files found');
```
**Note:** Only `node:*` built-in modules are available by default. Third-party packages require installation via the project's package manager (e.g. `npm install <pkg>`) before importing.
