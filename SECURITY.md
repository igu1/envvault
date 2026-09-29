# Security Policy

EnvVault is a secret manager, so security reports are taken seriously and
handled with priority.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub:
**https://github.com/igu1/envvault/security/advisories/new**

(or the repository's **Security → Report a vulnerability** tab). If that is
unavailable, contact the maintainer directly rather than filing a public issue.

Please include:

- the affected version,
- a description of the impact,
- reproduction steps or a proof of concept,
- any suggested fix, if you have one.

You can expect an acknowledgement within a few days. Please allow time for a fix
and a release before disclosing publicly.

## Scope

In scope:

- the cryptographic envelope and key derivation (`src/core/crypto.ts`)
- vault, session and configuration file handling and permissions
- the sharing server: authentication, encryption of share payloads, and access
  control (`src/server/`)
- path handling, command execution and injection paths (`envvault run`,
  `envvault docker`)

Out of scope:

- an attacker who already has read access to your user account, home directory
  or process memory (see the threat model in the README)
- a compromised machine, a malicious process running as your user, or a child
  process that logs its own environment
- weaknesses in a platform clipboard tool

## Design invariants

These are promises contributors must not break. A change that weakens one of
them is a security issue:

- Only `vault.enc` may contain secret **values**. `config.json`,
  `contexts.json`, `metadata.json`, `server.json` and every project-local
  `.envvault.json` may reference secret **names** only.
- The master password is never written to disk, never logged and never passed to
  a child process.
- Unlock sessions store only a **derived** key, never the master password.
- **Owner side:** `server.json` never stores a raw share token — only the
  scrypt-derived key and salt.
- **Client side:** `~/.envvault/share-tokens.json` (`0600`) *does* store the
  share tokens this device has been given, because they must be replayed on
  every request. It is the only file that keeps a raw token. It is written only
  after the server accepts the token (never on a rejection), and `--no-save` or
  `ENVVAULT_NO_TOKEN_STORE=1` keep it off disk entirely.
- Values are masked by default; revealing requires an explicit flag.
- Plaintext is never written to disk unless the user asked for it
  (`export --output`).
- The sharing server is disabled by default, binds loopback unless the operator
  opts into the network, and only reads key names that are explicitly
  allowlisted in a share.
- Share payloads are encrypted with a key derived from the share token, so the
  server never returns plaintext values in a response body. This does **not**
  replace TLS: the token is sent in the clear on every request and is the same
  secret the payload key is derived from, so a passive observer who captures a
  request can read those shares. Always use HTTPS beyond loopback.

## Hardening notes for operators

- Prefer loopback plus an SSH tunnel or a reverse proxy with TLS over binding
  directly to `0.0.0.0`. In particular, never serve over plain `http://` on a
  public host: the share token travels in the clear on every request.
- Keep token grants least-privileged: use `--shares <project>/<env>` rather than
  `--shares all`, and grant `--backup` only to machines that sync.
- Revoke tokens you no longer use with `envvault share token revoke <id>`; the
  change takes effect on the next request.
- A running `envvault serve` holds the derived vault key in memory. Run it as a
  dedicated, low-privilege user if that matters to you.
- `~/.envvault/share-tokens.json` holds the tokens this device uses to read
  other people's shares. Treat it like a password file: `0600`, not synced to
  anywhere you would not sync a credential, and cleared with
  `envvault tokens remove --all`.
