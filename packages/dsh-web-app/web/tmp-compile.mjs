import { compile } from "tailwindcss"
import { readFile } from "node:fs/promises"
const css = await readFile("tmp-text-md-test.css", "utf8")
try {
  const result = await compile(css, { base: "src" })
  console.log("BUILD OK — keys:", Object.keys(result))
  console.log(String(result.css).slice(0, 400))
} catch (e) {
  console.error("BUILD ERROR:", e.message)
  process.exit(1)
}
