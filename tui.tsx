import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ZEN_PROVIDER, GO_PROVIDER, unwrap, providerId, modelId } from "./shared/providers.ts"
import { fmt, fmtCost, until } from "./shared/format.ts"
import { bar } from "./shared/rows.ts"

// This plugin shows provider quota and usage for the OpenCode workspace
// (Zen/Go today; designed to extend to other providers).
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

function apiKey(): string {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))
    return String(auth?.[GO_PROVIDER]?.key ?? "")
  } catch {
    return ""
  }
}

// The usage endpoint accepts any workspace key. Try the Zen (opencode)
// provider key first, then fall back to the Go provider key, so the widget
// also works for users who only have a Zen key.
function apiKeys(): string[] {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))
    const keys = [auth?.[ZEN_PROVIDER]?.key, auth?.[GO_PROVIDER]?.key]
      .map((k) => String(k ?? "").trim())
      .filter(Boolean)
    return keys.length > 0 ? keys : [apiKey()]
  } catch {
    return apiKey() ? [apiKey()] : []
  }
}

// Sum tokens/cost across the session's assistant messages that used the
// given provider (go = opencode-go, zen = opencode). Reads shapes
// defensively; the plugin API is beta.
function providerTotals(context: any, providerID: string, sessionID?: string): GoTotals {
  const totals: GoTotals = { input: 0, output: 0, cost: 0 }
  if (!sessionID) return totals
  try {
    const messages = context.data.session.message.list(sessionID) ?? []
    for (const entry of messages) {
      const m = unwrap(entry)
      if (m?.role !== "assistant") continue
      const provider = providerId(m)
      if (provider !== providerID) continue
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

// Free Zen models: explicit -free suffixes plus the known always-free
// standbys. The server does not expose free-tier quota, so usage here is a
// local estimate from message history — useful for pace, not an authority.
function isFreeModel(id: string): boolean {
  const m = String(id || "").toLowerCase()
  return m.endsWith("-free") || m === "big-pickle"
}

interface FreeWindows {
  h5: number
  week: number
  month: number
}

interface FreeModelUsage {
  totals: FreeWindows
  byModel: Record<string, FreeWindows>
  // Per-model cooldowns parsed from limit errors found in message history
  // ("Try again in N hours" / resetsAt), keyed by model id.
  cooldowns: Record<string, number> // model id -> epoch ms when the window frees up
}

let freeCache: { at: number; value: FreeModelUsage } | null = null

// Extract a retry/cooldown epoch from a limit-error payload. The Zen API is
// the only place per-model free limits surface; the TUI persists those
// errors as message parts, so history doubles as our cooldown ledger.
function parseCooldown(text: string): number | null {
  if (!text) return null
  const now = Date.now()
  const absolute = text.match(/reset[^.\d]*(\d{4}-\d{2}-\d{2}[\dT .:+-]*Z)/i)
  if (absolute) {
    const ms = Date.parse(absolute[1])
    if (Number.isFinite(ms) && ms > now - 3600_000) return ms
  }
  const rel = text.match(/retry in (\d+)\s*(minute|hour|day|week)s?/i)
  if (rel) {
    const mult: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }
    return now + Number(rel[1]) * (mult[String(rel[2]).toLowerCase()] ?? 0)
  }
  if (/limit (reached|exceeded)|usagelimiterror/i.test(text)) return now + 3600_000 // unknown window: assume ≥1h
  return null
}

// Sum tokens per free model over the rolling 5h window, the current UTC
// week (Mon 00:00, matching the server's weekly window), and the current
// calendar month. Walks every cached session; throttled because it is
// O(sessions × messages).
function freeUsage(context: any): FreeModelUsage {
  if (freeCache && Date.now() - freeCache.at < 30_000) return freeCache.value
  const totals: FreeWindows = { h5: 0, week: 0, month: 0 }
  const byModel: Record<string, FreeWindows> = {}
  const cooldowns: Record<string, number> = {}
  const now = Date.now()
  const h5Start = now - 5 * 3600_000
  const weekStart = new Date(
    Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()),
  )
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)) // Monday
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
  const bump = (model: string, ts: number, total: number) => {
    const w = (byModel[model] ??= { h5: 0, week: 0, month: 0 })
    if (ts >= h5Start) {
      w.h5 += total
      totals.h5 += total
    }
    if (ts >= weekStart.getTime()) {
      w.week += total
      totals.week += total
    }
    if (ts >= monthStart) {
      w.month += total
      totals.month += total
    }
  }
  try {
    for (const s of context.data.session.list() ?? []) {
      const sid = (s as any)?.id ?? (s as any)?.info?.id
      if (!sid) continue
      for (const entry of context.data.session.message.list(sid) ?? []) {
        const m = unwrap(entry)
        const model = modelId(m)
        // Limit errors ride along as message parts; harvest their cooldown.
        for (const part of (m?.parts ?? []) as any[]) {
          const ptext = String(part?.error?.message ?? part?.error ?? part?.text ?? "")
          if (!/limit|usagelimiterror/i.test(ptext)) continue
          const untilMs = parseCooldown(ptext)
          const pmodel = String(part?.error?.modelID ?? part?.modelID ?? model)
          if (untilMs) cooldowns[pmodel] = Math.max(cooldowns[pmodel] ?? 0, untilMs)
        }
        if (m?.role !== "assistant" || !isFreeModel(model)) continue
        const tokens = m?.tokens ?? {}
        const total =
          (Number(tokens?.input ?? 0) || 0) +
          (Number(tokens?.output ?? 0) || 0) +
          (Number(tokens?.reasoning ?? 0) || 0) +
          (Number(tokens?.cache?.read?.input ?? 0) || 0)
        if (total <= 0) continue
        const ts = Date.parse(m?.time?.created ?? m?.timeCreated ?? m?.createdAt ?? "")
        if (!Number.isFinite(ts)) continue
        bump(model, ts, total)
      }
    }
  } catch {
    // Keep whatever was accumulated.
  }
  freeCache = { at: Date.now(), value: { totals, byModel, cooldowns } }
  return { totals, byModel, cooldowns }
}

// Plan quota from the same endpoint the console uses. Cached in module
// scope and persisted to durable storage: the slot render is synchronous, so
// the latest successful fetch is what gets displayed and a background timer
// keeps it fresh.
let cachedUsage: GoUsage | null = null
let lastFetch = 0
let lastSuccess = 0
let inFlight = false
let persist: ((usage: GoUsage) => void) | null = null

async function fetchUsage(): Promise<void> {
  const keys = apiKeys()
  if (keys.length === 0 || inFlight) return
  inFlight = true
  try {
    for (const key of keys) {
      try {
        const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${key}` } })
        if (res.ok) {
          cachedUsage = (await res.json()) as GoUsage
          lastSuccess = Date.now()
          lastFetch = lastSuccess
          persist?.(cachedUsage)
          return
        }
      } catch {
        // Try the next key; keep the last known usage on total failure.
      }
    }
  } finally {
    inFlight = false
  }
}

function refreshUsage(): void {
  if (Date.now() - lastFetch < POLL_MS) return
  lastFetch = Date.now() // throttle even when the request fails
  void fetchUsage()
}

// ---------------------------------------------------------------------------
// Shared row vocabulary — the common UI every view renders through.
// ---------------------------------------------------------------------------

/** A window row: label + value, with an optional server-reported percent
 * (renders the bar) and reset countdown. */
interface WindowRow {
  kind: "window"
  label: string
  value: string
  percent?: number
  resetsAt?: string
  warn?: boolean
}

/** A provider usage line: `label usage <tokens> tok · $<cost>`. */
interface UsageRow {
  kind: "usage"
  label: string
  providerID: string
}

/** Free-form line (model breakdown, status notes). */
interface TextRow {
  kind: "text"
  text: string
}

type Row = WindowRow | UsageRow | TextRow

function renderUsageRow(context: any, row: UsageRow, sessionID?: string): string {
  const t = providerTotals(context, row.providerID, sessionID)
  const active = t.input + t.output > 0 || t.cost > 0
  return active ? `${row.label} usage ${fmt(t.input + t.output)} tok · ${fmtCost(t.cost)}` : `${row.label} usage —`
}

function renderWindowRow(row: WindowRow): string {
  const value = typeof row.percent === "number" ? `${bar(row.percent)} ${row.percent}%` : row.value
  const line = `${row.label} ${value}${row.warn ? " ⚠" : ""}`
  const eta = until(row.resetsAt)
  return eta ? `${line} · resets ${eta}` : line
}

function renderRow(context: any, row: Row, sessionID?: string): string {
  switch (row.kind) {
    case "usage":
      return renderUsageRow(context, row, sessionID)
    case "window":
      return renderWindowRow(row)
    case "text":
      return row.text
  }
}

// Owns the sidebar footer via `replace` — the built-in aggregate USAGE block
// (cost/sessions/streak) is not shown; only the provider quota line is.
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
    void refreshConnections()
    const timer = setInterval(() => {
      refreshUsage()
      void refreshConnections()
    }, POLL_MS)

    const compact = context.options?.compact === true

    // Footer view selection. VIEWS is the single extension point: each entry
    // owns its rows() builder, so adding a provider means appending one entry
    // here — the picker, slash command, persistence, and footer renderer all
    // derive from the registry. The active view is persisted across restarts
    // and held in a signal so switching re-renders the footer.
    type ViewID = "go" | "zen"
    interface ProviderView {
      readonly id: ViewID
      readonly title: string
      readonly description: string
      /** Provider whose key gates this view (like /connect's list). */
      readonly providerID: string
      readonly rows: (sessionID?: string) => Row[]
    }

    // A view is available only when its provider is connected — read from
    // the same source /connect uses: the integration list, where an entry
    // with a non-empty `connections` array means an added key/credential.
    // Fetched via the client on a timer; until the first fetch lands (or if
    // the client is unavailable), fall back to reading auth.json directly.
    let connectedProviders: Set<string> | null = null
    const connectedFromAuth = (providerID: string): boolean => {
      try {
        const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))
        return Boolean(String(auth?.[providerID]?.key ?? "").trim())
      } catch {
        return false
      }
    }
    const hasKey = (providerID: string): boolean =>
      connectedProviders ? connectedProviders.has(providerID) : connectedFromAuth(providerID)
    const availableViews = () => VIEWS.filter((v) => hasKey(v.providerID))
    async function refreshConnections(): Promise<void> {
      try {
        const res = await context.client.integration.list()
        const items = (Array.isArray(res?.data) ? res.data : []) as Array<{ id?: string; connections?: unknown[] }>
        const next = new Set<string>()
        for (const item of items) if ((item.connections?.length ?? 0) > 0 && item.id) next.add(item.id)
        connectedProviders = next
      } catch {
        // Keep the previous set (or the auth.json fallback).
      }
    }

    // Plan quota rows (shared workspace quota; aggregates all providers).
    // Server-reported percents → bars. Never fetched: distinguish pending
    // from fetch failure. Compact mode keeps only the tightest window.
    const planQuotaRows = (): Row[] => {
      const windows: Array<[string, Window | undefined]> = [
        ["5h", cachedUsage?.usage?.rolling],
        ["1w", cachedUsage?.usage?.weekly],
        ["1mo", cachedUsage?.usage?.monthly],
      ]
      const known = windows.filter(([, w]) => w && typeof w.percent === "number") as Array<[string, Window]>
      if (known.length === 0) {
        const failed = lastFetch > 0 && Date.now() - lastFetch >= STALE_AFTER_MS && !inFlight
        return [{ kind: "text", text: failed ? "quota ✗ (fetch failed)" : "quota —" }]
      }
      const tightestIdx = known.reduce(
        (best, [, w], i) => ((w.percent ?? 0) > (known[best][1].percent ?? 0) ? i : best),
        0,
      )
      const shown = compact ? [known[tightestIdx]] : known
      const rows: Row[] = shown.map(([label, w]) => ({
        kind: "window",
        label,
        value: "",
        percent: w.percent,
        resetsAt: w.resetsAt,
        warn: !!w.status && w.status !== "ok",
      }))
      if (Date.now() - lastSuccess > STALE_AFTER_MS) rows.push({ kind: "text", text: "· stale" })
      return rows
    }

    const VIEWS: ProviderView[] = [
      {
        id: "go",
        title: "Go",
        description: "Go plan usage line and quota windows",
        providerID: GO_PROVIDER,
        rows: (sessionID) => [{ kind: "usage", label: "go", providerID: GO_PROVIDER }, ...planQuotaRows()],
      },
      {
        id: "zen",
        title: "Zen",
        description: "Zen usage and free-tier breakdown (no plan quota)",
        providerID: ZEN_PROVIDER,
        rows: (sessionID) => {
          // Free-tier pace is a local estimate; the server keeps no
          // free-quota API, so these rows carry token values without bars.
          const fw = freeUsage(context)
          const freeRows: Row[] = [
            { kind: "window", label: "free 5h", value: `${fmt(fw.totals.h5)} tok` },
            { kind: "window", label: "free 1w", value: `${fmt(fw.totals.week)} tok` },
            { kind: "window", label: "free 1mo", value: `${fmt(fw.totals.month)} tok` },
          ]
          // Per-model breakdown: models active in the 5h window, with any
          // known cooldown countdown appended. Server limits are not
          // queryable, so the cooldown only appears after a limit error.
          const modelRows: Row[] = Object.entries(fw.byModel)
            .filter(([id, w]) => w.h5 > 0 || (fw.cooldowns[id] ?? 0) > Date.now())
            .sort((a, b) => b[1].h5 - a[1].h5)
            .map(([id, w]) => {
              const cd = fw.cooldowns[id]
              const cdTxt = cd && cd > Date.now() ? ` ⏳${until(new Date(cd).toISOString())}` : ""
              return { kind: "text", text: `${id} ${fmt(w.h5)}${cdTxt}` } as Row
            })
          return [{ kind: "usage", label: "zen", providerID: ZEN_PROVIDER }, ...freeRows, ...modelRows]
        },
      },
    ]

    const [view, setView] = createSignal<ViewID>("go")
    // Auto-pick: the active view must be available (its provider key is
    // added). If the user's persisted/active view lost its key — or no
    // explicit pick has been made and only one provider is connected — fall
    // back to the first available view. Computed, never set during render,
    // so reactivity stays clean; manual picks via /usage-view still win.
    // Provider the current session is actually using: the provider of the
    // most recent assistant message. Defensive reads; beta API.
    const sessionProvider = (sessionID?: string): string | null => {
      if (!sessionID) return null
      try {
        const messages = context.data.session.message.list(sessionID) ?? []
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = (messages[i] as any)?.info ?? messages[i]
          if (m?.role !== "assistant") continue
          return String(m?.model?.providerID ?? m?.providerID ?? "") || null
        }
      } catch {
        // Fall through.
      }
      return null
    }

    // Auto-pick precedence:
    // 1. The view matching the provider the session is actively using
    //    (only when its key is added) — the footer follows what you use.
    // 2. The user's persisted/manual pick via /usage-view, if still available.
    // 3. The first connected view.
    // Computed, never set during render, so reactivity stays clean.
    const effectiveView = (sessionID?: string): ViewID => {
      const available = availableViews()
      if (available.length === 0) return view()
      const used = sessionProvider(sessionID)
      const usedView = used ? available.find((v) => v.providerID === used) : undefined
      return (usedView?.id ?? (available.some((v) => v.id === view()) ? view() : available[0].id)) as ViewID
    }
    const applyView = (next: ViewID) => {
      if (next === view()) return
      setView(next)
      try {
        const [viewStore] = context.storage.store("view", { initial: { view: "go" as ViewID } })
        viewStore.view = next
      } catch {
        // In-memory only.
      }
      try {
        context.ui.toast.show({
          message: `Usage footer: ${VIEWS.find((v) => v.id === next)?.title ?? next} view`,
          variant: "success",
        })
      } catch {
        // Toast unavailable; the footer still re-renders.
      }
    }
    try {
      const [viewStore] = context.storage.store("view", { initial: { view: "go" as ViewID } })
      if (VIEWS.some((v) => v.id === viewStore.view)) setView(viewStore.view)
    } catch {
      // In-memory only.
    }
    const currentView = (sessionID?: string) => VIEWS.find((v) => v.id === effectiveView(sessionID))!

    // Opens a picker over the *available* views (provider key added); a
    // non-empty argument selects that view directly (e.g. `/usage-view zen`).
    const pickView = async (arg?: string) => {
      const wanted = arg?.trim().toLowerCase()
      const available = availableViews()
      if (wanted) {
        const match = VIEWS.find((v) => v.id === wanted || v.title.toLowerCase() === wanted)
        if (match) {
          if (available.includes(match)) return applyView(match.id)
          try {
            await context.ui.dialog.alert({
              title: "Usage view",
              message: `${match.title} has no API key added. Run /connect to add it first.`,
            })
          } catch {
            // Dialog unavailable.
          }
          return
        }
        try {
          await context.ui.dialog.alert({
            title: "Usage view",
            message: `Unknown view "${arg}". Available: ${available.map((v) => v.id).join(", ") || "none (no provider keys added)"}`,
          })
        } catch {
          // Dialog unavailable.
        }
        return
      }
      try {
        const selected = await context.ui.dialog.select({
          title: "Usage view",
          message: "Choose the provider view shown in the sidebar footer",
          current: effectiveView(),
          options: available.map((v) => ({
            title: v.title,
            value: v.id,
            description: v.description,
            disabled: false,
          })),
        })
        if (selected) applyView(selected)
      } catch {
        // Dialog unavailable.
      }
    }

    // Keymap layers are owned by the calling component, so the /usage-view
    // command is registered from a rendered slot (an empty `app` contribution)
    // rather than from setup() — a layer registered directly in setup() never
    // becomes active.
    context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap.layer(() => ({
            mode: "global",
            priority: 10,
            commands: [
              {
                id: "usage.view",
                title: `Usage footer: view provider (${currentView().title})`,
                description: "Pick which provider's usage the sidebar footer shows",
                group: "Usage",
                palette: true,
                slash: { name: "usage-view", aliases: ["usage"], arguments: true },
                suggested: true,
                run: (input?: string) => {
                  void pickView(input)
                },
              },
            ],
          }))
        } catch (err) {
          console.warn("opencode-usage-quota-tracker: keymap.layer unavailable", err)
        }
        return null
      },
    })

    const slot = context.ui.slot({
      replace: "sidebar.footer",
      render: ({ sessionID }: { sessionID?: string }) => {
        refreshUsage()

        // No workspace key configured: render nothing instead of dead weight.
        if (apiKeys().length === 0) return null

        // One shared renderer: the active view's registry entry supplies the
        // rows, the footer just paints them.
        const lines = currentView(sessionID)
          .rows(sessionID)
          .map((row) => renderRow(context, row, sessionID))
          .filter((l) => l !== "")
        return <text>{lines.join("\n")}</text>
      },
    })

    return () => {
      clearInterval(timer)
      slot?.()
    }
  },
})
