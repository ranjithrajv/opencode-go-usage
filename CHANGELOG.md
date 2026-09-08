# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sidebar footer showing live provider quota and usage
- Per-provider usage tracking (Go plan quota + Zen free-tier breakdown)
- View picker with provider-key gating and session-following auto-pick
- Polling fetcher with multi-key fallback, degrading to the last-known-good cache on parse failure

[Unreleased]: https://github.com/ranjithraj/opencode-usage-quota-tracker/compare/v0.1.0...HEAD
