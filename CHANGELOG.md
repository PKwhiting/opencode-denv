# Changelog

## 0.1.0 - 2026-07-01

- Added plugin mode for routing opencode sessions to remote environments by
  session title.
- Added `denv-run` SSH helper with ControlMaster reuse and command base64
  wrapping.
- Added launcher mode for a single fully locked opencode instance per
  environment.
- Added safety behavior that denies local file tools in remote-bound sessions.
- Added TypeScript validation, unit tests, shellcheck CI, public examples,
  security notes, and MIT license.
