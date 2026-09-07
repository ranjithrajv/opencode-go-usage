# opencode-go-usage

Track live Go provider (`opencode-go`) quota usage in [OpenCode](https://opencode.ai) V2.

- A **sidebar footer** widget in the TUI shows the current session's token and cost usage, live.
- Quota rows for the 5h / 1w / 1mo windows of your Zen/Go workspace, with lean progress bars and reset countdowns.

It works with either a **Zen** (`opencode`) or a **Go** (`opencode-go`) API key — both authenticate against the same workspace usage endpoint.

It only renders into the `sidebar.footer` slot — it never modifies sidebar content and never injects messages into sessions.

## Prerequisites

- OpenCode **V2** (plugin API is beta)
- A **Zen** (`opencode`) or **Go** (`opencode-go`) API key: run `opencode2 auth login`. Without one the widget renders nothing.

## Install

Add the plugin to your CLI config at `~/.config/opencode/cli.json`:

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-go-usage"]
}
```

Pin a version or pass options if you like:

```jsonc
{
  "plugins": ["opencode-go-usage@0.1.0"]
}
```

Or install per project without any config: copy the folder to `<project>/.opencode/plugins/opencode-go-usage/` — it is discovered automatically.

## Usage

Once installed and the TUI is restarted, the sidebar footer shows two lines: `go usage <tokens> tok · $<cost>` (current session) and the plan quota `5h <x>% · week <y>% · month <z>%` with reset countdowns. It refreshes every minute — no commands to run.

## Remove

Remove the `plugins` entry from `cli.json` (or delete the folder from `.opencode/plugins/`).

## Compatibility

Built against the OpenCode V2 plugin API (`@opencode-ai/plugin` `beta`). The plugin API is beta; see each release's notes for compatibility.

## License

MIT
