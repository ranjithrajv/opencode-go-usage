# Changelog

## [0.1.0] - 2026-09-07

### Added
- Sidebar footer widget showing live OpenCode Go plan quota: 5h / 1w / 1mo windows with lean inline progress bars, percent, and reset countdowns.
- Session-level token and cost totals for the `opencode-go` provider.
- Quota polling every 60s with staleness indicator (`· stale`) after failed refreshes.
- Distinct fetch-failure state (`quota ✗`) vs pending state (`quota —`).
- Durable persistence of last known quota across TUI restarts.
- `compact` option to show only the tightest window.
- Graceful no-op when no `opencode-go` API key is configured.
