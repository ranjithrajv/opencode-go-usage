import { Plugin } from "@opencode-ai/plugin/tui"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// This plugin focuses on Go provider quota usage only.
const GO_PROVIDER = "opencode-go"
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const POLL_MS = 60_000
const STALE_AFTER_MS = 2 * POLL_MS

interface Window {
  status?: string
  percent?: number
  resetsAt?: string
}

interface GoUsage {
  usage?: {
    rolling?: Window
    weekly?: Window
    monthly?: Window
  }
}

interface GoTotals {
  input: number
  output: number
  cost: number
}

function fmt(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "0"
}

function fmtCost(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return `$${v.toFixed(4)}`
  if (typeof v === "string" && v.trim() !== "") return v
  return "$0.0000"
}

function apiKey(): string {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))
    return String(auth?.[GO_PROVIDER]?.key ?? "")
  } catch {
    return ""
  }
}

function until(iso: string | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h}h ${mins % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Sum tokens/cost across the session's assistant messages that used the Go
// provider. Reads shapes defensively; the plugin API is beta.
function goTotals(context: any, sessionID?: string): GoTotals {
  const totals: GoTotals = { input: 0, output: 0, cost: 0 }
  if (!sessionID) return totals
  try {
    const messages = context.data.session.message.list(sessionID) ?? []
    for (const entry of messages) {
      const m = (entry as any)?.info ?? entry
      if (m?.role !== "assistant") continue
      const provider = m?.model?.providerID ?? m?.providerID
      if (provider !== GO_PROVIDER) continue
      const tokens = m?.tokens ?? {}
      totals.input += Number(tokens?.input ?? 0) || 0
      totals.output += Number(tokens?.output ?? 0) || 0
      totals.cost += Number(m?.cost ?? 0) || 0
    }
  } catch {
    // Fall through with whatever was accumulated.
  }
  return totals
}

// Go plan quota from the same endpoint the console uses. Cached in module
// scope and persisted to durable storage: the slot render is synchronous, so
// the latest successful fetch is what gets displayed and a background timer
// keeps it fresh.
let cachedUsage: GoUsage | null = null
let lastFetch = 0
let lastSuccess = 0
let inFlight = false
let persist: ((usage: GoUsage) => void) | null = null

async function fetchUsage(): Promise<void> {
  const key = apiKey()
  if (!key || inFlight) return
  inFlight = true
  try {
    const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${key}` } })
    if (res.ok) {
      cachedUsage = (await res.json()) as GoUsage
      lastSuccess = Date.now()
      lastFetch = lastSuccess
      persist?.(cachedUsage)
    }
  } catch {
    // Keep the last known usage; render() reports staleness.
  } finally {
    inFlight = false
  }
}

function refreshUsage(): void {
  if (Date.now() - lastFetch < POLL_MS) return
  lastFetch = Date.now() // throttle even when the request fails
  void fetchUsage()
}

// Lean inline progress bar: [━━──] — half-height line glyphs keep the row slim.
function bar(percent: number): string {
  const cells = 10
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return `[${"━".repeat(filled)}${"─".repeat(cells - filled)}]`
}

// Owns the sidebar footer via `replace` — the built-in aggregate USAGE block
// (cost/sessions/streak) is not shown; only the Go provider quota line is.
// Never touches sidebar content or session messages.
export default Plugin.define({
  id: "opencode-go.usage.tui",
  setup(context: any) {
    // Durable persistence: show the last known quota immediately after a
    // TUI restart instead of `quota —` until the first poll completes.
    try {
      const [store] = context.storage.store("usage", { initial: { usage: null as GoUsage | null, at: 0 } })
      persist = (usage) => {
        store.usage = usage
        store.at = Date.now()
      }
      if (!cachedUsage && store.usage) {
        cachedUsage = store.usage
        lastSuccess = store.at
        lastFetch = store.at
      }
    } catch {
      // Storage unavailable; cache stays in-memory only.
    }

    refreshUsage()
    const timer = setInterval(refreshUsage, POLL_MS)

    const compact = context.options?.compact === true

    const slot = context.ui.slot({
      replace: "sidebar.footer",
      render: ({ sessionID }: { sessionID?: string }) => {
        refreshUsage()

        // No Go key configured: render nothing instead of dead weight.
        if (!apiKey()) return null

        const t = goTotals(context, sessionID)
        const goModel = t.input + t.output > 0 || t.cost > 0
        const usage = goModel
          ? `go usage ${fmt(t.input + t.output)} tok · ${fmtCost(t.cost)}`
          : "go usage —"

        const windows: Array<[string, Window | undefined]> = [
          ["5h", cachedUsage?.usage?.rolling],
          ["1w", cachedUsage?.usage?.weekly],
          ["1mo", cachedUsage?.usage?.monthly],
        ]
        const known = windows.filter(([, w]) => w && typeof w.percent === "number") as Array<[string, Window]>

        // Never fetched successfully: distinguish fetch failure from pending.
        if (known.length === 0) {
          const failed = lastFetch > 0 && Date.now() - lastFetch >= STALE_AFTER_MS && !inFlight
          return <text>{failed ? `${usage}\nquota ✗ (fetch failed)` : `${usage}\nquota —`}</text>
        }

        const stale = Date.now() - lastSuccess > STALE_AFTER_MS

        // Compact mode: only the tightest window.
        const tightestIdx = known.reduce(
          (best, [, w], i) => ((w.percent ?? 0) > (known[best][1].percent ?? 0) ? i : best),
          0,
        )
        const shown = compact ? [known[tightestIdx]] : known

        const lines = shown.map(([label, w]) => {
          const p = w.percent ?? 0
          const eta = until(w.resetsAt)
          const flag = w.status && w.status !== "ok" ? " ⚠" : ""
          const line = `${label} ${bar(p)} ${p}%${flag}`
          return eta ? `${line} · resets ${eta}` : line
        })
        if (stale) lines.push("· stale")
        const quotaLines = lines.join("\n")

        return <text>{`${usage}\n${quotaLines}`}</text>
      },
    })

    return () => {
      clearInterval(timer)
      slot?.()
    }
  },
})
