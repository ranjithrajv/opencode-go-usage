# Changelog

## [0.1.0] - 2026-09-07

### Added

- Sidebar footer widget showing live OpenCode Go plan quota: 5h / 1w / 1mo windows with lean inline progress bars, percent, and reset countdowns.
- Session-level token and cost totals for the `opencode-go` provider.
- Zen usage line: session tokens and cost for the `opencode` (Zen) provider, alongside the Go line. The quota windows are workspace-wide; the footer covers both plans' usage explicitly.
- Free-tier tracking line: `zen free 5h / 1w / 1mo` token totals computed locally from session history (models ending in `-free` plus `big-pickle`). The server exposes no free-quota API, so this is a pace estimate, not the authoritative server counter.
- Per-model free-tier tracking: free models active in the rolling 5h window are listed individually with token totals; a `⏳` countdown appears once a `FreeUsageLimitError`-style message is found in history (the only server-side signal for per-model free limits).
- Footer view switch: `/usage-view` (also in the command palette) toggles between **Go** (Go line + quota windows) and **Zen** (Zen line, free-tier totals, per-model 5h usage with cooldown countdowns). Choice persists across TUI restarts.
- Weekly window matches the server's Monday 00:00 UTC boundary.
- Quota polling every 60s with staleness indicator (`· stale`) after failed refreshes.
- Distinct fetch-failure state (`quota ✗`) vs pending state (`quota —`).
- Durable persistence of last known quota across TUI restarts.
- `compact` option to show only the tightest window.
- Graceful no-op when no `opencode-go` or `opencode` API key is configured.

### Changed

- Licensed under the GNU Affero General Public License v3.0.
