import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { transformAsync } from "@babel/core"

const root = new URL("../", import.meta.url)
const source = new URL("src/", root)
const output = new URL("dist/", root)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

// Compile Solid to OpenTUI's universal renderer, never to a React JSX runtime.
// Precompiled JS also works with OpenCode's Node-based Windows distribution.
const localExtensions = () => ({
  visitor: {
    ImportDeclaration(path) {
      const value = path.node.source.value
      if (value.startsWith(".")) path.node.source.value = value.replace(/\.tsx?$/, ".js")
    },
  },
})
for (const name of await readdir(source)) {
  if (!/\.tsx?$/.test(name)) continue
  const path = new URL(name, source)
  const result = await transformAsync(await readFile(path, "utf8"), {
    filename: fileURLToPath(path),
    babelrc: false, configFile: false,
    presets: [
      ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }],
      ["@babel/preset-typescript", { allExtensions: true, isTSX: name.endsWith(".tsx") }],
    ],
    plugins: [localExtensions],
    sourceMaps: true,
  })
  const target = name.replace(/\.tsx?$/, ".js")
  await writeFile(new URL(target, output), `${result.code}\n//# sourceMappingURL=${target}.map\n`)
  await writeFile(new URL(`${target}.map`, output), JSON.stringify(result.map))
}
console.log("Built server and terminal plugin entrypoints in dist/")
