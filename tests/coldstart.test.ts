import { describe, expect, test, vi } from "vitest"
import plugin from "../tui.js"
import serverPlugin from "../index.js"

// Cold start: no auth.json keys, empty durable storage, service unreachable.
// setup() must complete, register the footer slot, and the footer must
// render nothing (not crash) until keys are configured.
vi.mock("opencode-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("opencode-plugin-kit")>()
  return {
    ...actual,
    authKeys: vi.fn(() => []),
    // Real cold-start behavior: no auth.json falls back to Zen + Go.
    availableProviders: vi.fn(() => ["opencode", "opencode-go"]),
    hasKey: vi.fn(() => false),
  }
})

function emptyCtx() {
  const slots: Array<Record<string, unknown>> = []
  const ctx: any = {
    storage: {
      store: (_key: string, opts: { initial: unknown }) => [{ ...structuredClone(opts.initial) }],
    },
    ui: {
      slot: (o: Record<string, unknown>) => {
        slots.push(o)
        return () => {}
      },
      toast: { show: () => {} },
      dialog: { alert: () => Promise.resolve(), select: () => Promise.resolve() },
    },
    keymap: { layer: () => {} },
    client: new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "integration") {
            return { list: () => Promise.reject(new Error("cold start: no service")) }
          }
          return () => Promise.reject(new Error("cold start: no service"))
        },
        set: () => true,
      },
    ),
    options: {},
    data: {
      session: { list: () => [], message: { list: () => [] } },
      location: { default: () => ({ directory: "/nonexistent-project" }) },
    },
    theme: { text: { default: "#fff", subdued: "#888" } },
  }
  return { ctx, slots }
}

describe("cold start", () => {
  test("server entrypoint is a no-op that completes", async () => {
    await expect(Promise.resolve(serverPlugin.setup({} as any))).resolves.toBeUndefined()
  })

  test("setup completes with no keys and registers the footer slot", async () => {
    const { ctx, slots } = emptyCtx()
    const cleanup = await plugin.setup(ctx)
    expect(typeof cleanup).toBe("function")
    const targets = slots.map((s) => s.after ?? s.append ?? s.replace)
    expect(targets).toContain("sidebar.footer")
    expect(() => cleanup()).not.toThrow()
  })

  test("the footer renders nothing when no workspace keys exist", async () => {
    const { ctx, slots } = emptyCtx()
    await plugin.setup(ctx)
    const footer = slots.find((s) => s.replace === "sidebar.footer") as any
    expect(footer).toBeTruthy()
    expect(footer.render({ sessionID: undefined })).toBeNull()
  })

  test("repeated setup on empty stores is idempotent", async () => {
    const { ctx } = emptyCtx()
    await Promise.resolve(plugin.setup(ctx))
    await expect(Promise.resolve(plugin.setup(ctx))).resolves.toBeDefined()
  })
})
