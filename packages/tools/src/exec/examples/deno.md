- `deno` (TypeScript, --allow-all): secure-by-default runtime
  ```
  const entries = [...Deno.readDirSync("./src")];
  console.log(entries.length + ' entries');
  ```
