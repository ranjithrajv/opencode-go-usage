import { defineConfig, type Plugin } from "vitest/config"
const hoistDefault = (): Plugin => ({
  name: "hoist-default-export",
  transform(code, id) {
    if (!id.endsWith("g.ts")) return null
    return code.replace(/^export default /m, "const _default = ") + "\nexport default _default\n"
  },
})
export default defineConfig({
  plugins: [hoistDefault()],
  test: { environment: "happy-dom", include: ["g.test.ts"], coverage: { provider: "v8", include: ["g.ts"] } },
})
