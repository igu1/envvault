# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Opt-in sharing server (`envvault serve`). Disabled by default, binds
  `127.0.0.1` unless you explicitly opt into the network.
- `envvault server` to enable/disable sharing and set the bind address and port,
  persisted in `~/.envvault/server.json` (secret names and token derivatives
  only).
- `envvault share` to expose a project/environment with a per-key allowlist, and
  to create/list/revoke access tokens. Tokens are shown once and stored only as
  an scrypt-derived key plus salt.
- `envvault connect <url>` to pull a share into a chosen scope (`--global`,
  `--project/--env`, or `--project --shared`), with `--list` and `--dry-run`.
- `envvault sync` to push/pull/list/remove encrypted vault backups. Pulls keep
  the previous `vault.enc` as a `.bak-<timestamp>` file.
- End-to-end encryption for shares: payloads are encrypted with a key derived
  from the share token, using the same AES-256-GCM + scrypt envelope as the
  vault, so responses are ciphertext even over plain HTTP.
- TUI "Sharing & server" settings, a key-picker for shares, a "where should the
  token be stored?" step (clipboard / `0600` file / screen), and a startup
  notification when sharing is enabled.
- `ENVVAULT_SHARE_TOKEN` environment variable for non-interactive use.
- New exit code `6` for network/server failures.

### Changed

- The README's local-first positioning now documents the optional sharing
  server instead of stating there is no server at all.

## [0.1.0] - 2026-09-29

### Added

- Initial release: local-first encrypted secret manager.
- `init`, `unlock`, `lock`, `project`, `use`, `unuse`, `set`, `get`, `list`,
  `delete`, `import`, `export`, `run`, `copy`, `doctor`, `ui` and `docker`.
- AES-256-GCM vault with scrypt key derivation, atomic writes and `0600`/`0700`
  file permissions.
- Optional unlock sessions that cache the derived key (never the password).
- Docker and Docker Compose integration with per-service least privilege.

<!--
Once the repository is hosted, add compare links here, for example:

[Unreleased]: https://github.com/<owner>/envvault/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<owner>/envvault/releases/tag/v0.1.0
-->
