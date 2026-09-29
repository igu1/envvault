# EnvVault

One encrypted vault for every project, terminal and Docker container.

Stop copying `.env` files between projects. EnvVault stores your environment
variables in one encrypted local vault and injects them only when your
application runs.

```bash
npm install -g @igu1/envvault

envvault init
```

```text
EnvVault

✓ Created ~/.envvault
✓ Created encrypted vault

EnvVault is ready.
```

EnvVault is **local-first**: everything lives in a single encrypted file on your
machine (`~/.envvault/vault.enc`). There is no account and no telemetry. An
optional, off-by-default [sharing server](#sharing) can expose selected keys to
other machines, and it only runs when you enable it. Secrets are injected as ordinary environment variables, so it works
with any language or framework — Node.js, Next.js, Django, Python, Go, Rust,
PHP, Java, Docker and plain shell scripts.

## Contents

- [Why](#why)
- [Install](#install)
- [Five-minute quick start](#five-minute-quick-start)
- [Concepts](#concepts)
- [Commands](#commands)
- [Sharing](#sharing)
- [Docker](#docker)
- [Security design](#security-design)
- [Environment variables](#environment-variables)
- [Exit codes](#exit-codes)
- [Development](#development)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why

- **One vault instead of scattered `.env` files.** Global secrets, project-wide
  secrets and per-environment overrides, all in one place.
- **Secrets are injected, not written to disk.** `envvault run -- npm run dev`
  gives the process the values it needs without producing a plaintext `.env`.
- **Docker is a first-class citizen.** Inject into `docker compose`, `docker run`
  and BuildKit builds — no `.env` file required.
- **Least privilege by default.** A Compose service only receives the secret
  names you allow in `.envvault.json`.
- **Framework independent.** Applications just read `process.env`,
  `os.environ`, `os.Getenv`, and so on.

---

## Install

```bash
npm install -g @igu1/envvault
```

or as a project dependency:

```bash
npm install @igu1/envvault
```

Requires Node.js 20 or newer.

---

## Five-minute quick start

```bash
# 1. create the vault (asks for a master password, input is hidden)
envvault init

# 2. go to your project
cd ~/projects/my-project

# 3. register a project with a default environment
envvault project add my-project --env dev

# 4. bind this directory to my-project/dev
envvault use my-project/dev

# 5. import an existing .env (the file is left in place)
envvault import .env

# 6. see what is stored (values are always masked)
envvault list
```

```text
my-project / dev

DATABASE_URL       ••••••••••••
REDIS_URL          ••••••••••••
API_KEY            ••••••••••••
```

Run your app with the secrets injected:

```bash
envvault run -- npm run dev
```

```js
// app.js — no EnvVault dependency
console.log(Boolean(process.env.DATABASE_URL)); // true
console.log(Boolean(process.env.API_KEY));      // true
```

Docker Compose, with no `.env` file:

```bash
envvault docker compose up
```

---

## Concepts

### The vault

There is exactly one vault per machine at `~/.envvault/`. It is encrypted with
AES-256-GCM using a key derived from your master password with scrypt. The
master password is never stored.

### Global, project and environment secrets

```text
Vault
├── Global                      (shared by every project)
│   ├── GITHUB_TOKEN
│   └── OPENAI_API_KEY
│
├── crono
│   ├── shared                  (shared by every crono environment)
│   │   └── COMPANY_NAME
│   ├── dev
│   │   ├── DATABASE_URL
│   │   └── REDIS_URL
│   └── production
│       ├── DATABASE_URL
│       └── REDIS_URL
│
└── justblocks
    └── dev
```

Resolution precedence, lowest to highest:

```text
global  →  project shared  →  environment
```

An environment value overrides a project value, which overrides a global value.

```bash
envvault set OPENAI_API_KEY --global                      # every project
envvault set COMPANY_NAME --project crono --shared        # every crono env
envvault set DATABASE_URL                                 # active environment
envvault set DATABASE_URL --project crono --env production
```

### Directory context

`envvault use` binds an absolute directory to a project/environment. Commands
run inside that directory (or any subdirectory) resolve the context
automatically, and the most specific mapping wins.

```bash
cd ~/projects/crono
envvault use crono/dev

cd backend        # ~/projects/crono/backend inherits crono/dev
envvault list     # shows crono/dev secrets
```

Mappings are stored in `~/.envvault/contexts.json`. A project-local
`.envvault.json` with `project` and `environment` also works as a fallback.
Disconnect a directory again with `envvault unuse`.

When a directory is not bound, `list`, `set` and `get` fall back to the global
secrets (`set` prints a short note so you always know where a value landed).
Commands that need project secrets (`run`, `export`, `doctor`, `copy`, `delete`,
`import`) require a context or an explicit `--project`/`--env`.

### Unlock sessions

Authenticating on every single command gets in the way when you are running a
dev server or a test loop. An **unlock session** caches the *derived vault key*
(never the master password) in `~/.envvault/session.json` with an expiry:

```bash
envvault unlock --ttl 8h
envvault run -- npm run dev        # repeated runs never prompt
envvault lock                      # clear it explicitly
```

- The default TTL is **8 hours**; `--ttl` accepts `30s`, `15m`, `8h`, `7d`, `2w`.
- The session is invalidated automatically if it expires or if the cached key
  no longer matches the vault.
- `ENVVAULT_NO_SESSION=1` ignores (and does not create) sessions — useful for
  automation that must always supply a password explicitly.

Sessions are created only by `envvault unlock`; commands never write the key to
disk on their own.

---

## Commands

```bash
envvault --help       # full command reference
envvault --version    # installed version
```

| Command | Purpose |
| ------- | ------- |
| `envvault init` | Create the EnvVault directory and encrypted vault |
| `envvault unlock` | Cache the key so commands stop prompting |
| `envvault lock` | Clear the cached unlock session |
| `envvault project add\|list\|remove` | Manage projects and environments |
| `envvault use` | Bind this directory to a project/environment |
| `envvault unuse` | Disconnect a directory from its project |
| `envvault set` | Store a secret |
| `envvault get` | Read a secret (masked unless `--reveal`) |
| `envvault list` | List secret names without values |
| `envvault delete` | Delete a secret (asks first) |
| `envvault import` | Import a `.env` file |
| `envvault export` | Export secrets explicitly |
| `envvault run` | Run a command with injected secrets |
| `envvault copy` | Copy a secret to the clipboard |
| `envvault doctor` | Check code against the vault |
| `envvault ui` | Interactive terminal UI |
| `envvault docker` | Docker and Docker Compose integration |
| `envvault server` | Enable and configure the sharing server |
| `envvault share` | Manage shared environments and access tokens |
| `envvault serve` | Run the sharing server (opt-in) |
| `envvault connect` | Pull shared keys from another vault |
| `envvault sync` | Push or pull an encrypted vault backup |
| `envvault tokens` | List or forget share tokens saved on this device |

### `envvault init`

Create the EnvVault directory and the encrypted vault. Prompts for a master
password twice (never echoes). Refuses to overwrite an existing vault.

### `envvault project`

```bash
envvault project add crono --env dev                 # create a project + environment
envvault project add crono --env production          # add another environment later
envvault project add crono --env staging,qa          # or several at once

envvault project list                                # list projects
envvault project list --environments                 # list projects and their environments

envvault project remove crono                        # asks for confirmation, use --yes to skip
```

Adding an environment to an existing project is safe and idempotent: a new
environment is created, while one that already exists is reported and left
untouched.

```text
$ envvault project add crono --env production
✓ Created environment: crono/production
```

### `envvault unlock` and `envvault lock`

By default every command asks for the master password. Unlock once to cache the
derived key for a while — then `envvault run`, `list`, `set` and the rest work
without prompting.

```bash
envvault unlock                 # cache for 8 hours (default)
envvault unlock --ttl 30m
envvault unlock --ttl 7d

envvault run -- npm run dev     # no prompt
envvault lock                   # forget the cached key now
```

```text
$ envvault unlock
✓ Vault unlocked
Session expires in 8 hours (2026-09-29, 10:15:00 PM).
Run `envvault lock` to clear it now.
```

See [Unlock sessions](#unlock-sessions) for the security trade-off.

### `envvault use`

```bash
envvault use crono/dev     # bind the current directory
envvault use               # show the context for the current directory
```

### `envvault unuse`

Disconnect a directory from its project.

```bash
envvault unuse             # disconnect the current directory
envvault unuse ~/projects/crono
```

```text
$ envvault unuse
✓ Disconnected /home/me/projects/crono
```

It needs no master password (nothing secret is involved), so it is safe in
scripts. If the current directory only *inherits* a parent mapping, EnvVault
tells you which directory owns it instead of silently doing nothing. If the
context comes from a committed `.envvault.json`, remove the `project` and
`environment` fields from that file.

### `envvault set`

Values are read from a hidden prompt, or from stdin with `--stdin`. Values are
never accepted as positional arguments (they would leak into shell history).

```bash
envvault set DATABASE_URL
envvault set DATABASE_URL --project crono --env dev
envvault set COMPANY_NAME --project crono --shared
envvault set OPENAI_API_KEY --global

printf '%s' "$TOKEN" | envvault set TOKEN --stdin
```

### `envvault get`

Masked by default. Revealing is explicit.

```bash
envvault get DATABASE_URL                 # DATABASE_URL=••••••••••••••
envvault get DATABASE_URL --reveal        # prints a warning, then the value
envvault get DATABASE_URL --reveal --raw  # value only, for scripts
```

### `envvault list`

Never prints values.

```bash
envvault list
envvault list --origins                    # show where each value comes from
envvault list --global
envvault list --project crono --env production
envvault list --project crono --shared
```

```text
crono / dev

DATABASE_URL       environment
REDIS_URL          environment
OPENAI_API_KEY     global
COMPANY_NAME       project shared
```

In a directory with no project context, `envvault list` shows the global
secrets instead of failing, and reminds you to bind a context.

### `envvault delete`

```bash
envvault delete DATABASE_URL
envvault delete DATABASE_URL --yes   # for automation
```

### `envvault import`

```bash
envvault import .env
envvault import .env --overwrite
envvault import .env --global
envvault import .env --project crono --env production
```

Supports `KEY=value`, quoted values, comments, blank lines, inline comments and
`=` inside values. It **never executes** the file contents. The original `.env`
is not deleted.

### `envvault export`

Plaintext output only happens when you ask for it.

```bash
envvault export                      # .env format to stdout
envvault export --format json
envvault export --format shell
envvault export --output .env        # warns, writes with 0600 permissions
```

### `envvault run`

```bash
envvault run -- npm run dev
envvault run -- python manage.py runserver
envvault run --env production -- docker compose logs -f
```

Resolved secrets are merged into the child environment; stdin/stdout/stderr and
the exit code are passed through. The child has no dependency on EnvVault.
Inside an active [unlock session](#unlock-sessions) this command does not prompt
for the master password.

### `envvault copy`

```bash
envvault copy OPENAI_API_KEY
envvault copy OPENAI_API_KEY --clear-after 15
envvault copy OPENAI_API_KEY --no-clear
```

```text
✓ Copied OPENAI_API_KEY
Clipboard will be cleared in 30 seconds.
```

### `envvault doctor`

Compares variables referenced in your source code (and `.env.example`) with the
vault.

```bash
envvault doctor
envvault doctor --strict     # non-zero exit when variables are missing
```

```text
EnvVault Doctor

Project:
crono / dev

✓ DATABASE_URL
✓ REDIS_URL
✓ SECRET_KEY

✗ SMTP_PASSWORD
  referenced in:
  src/email.ts:18
  but missing from EnvVault

⚠ OLD_STRIPE_KEY
  exists in EnvVault
  but was not found in project source

1 missing
1 possibly unused
```

Detected patterns include `process.env.NAME`, `process.env["NAME"]`,
`import.meta.env.NAME`, Python `os.environ["NAME"]`/`os.getenv("NAME")`, Go
`os.Getenv("NAME")`, Rust `std::env::var("NAME")`, Java
`System.getenv("NAME")`, Dockerfile `ARG`/`ENV`, and `$VAR` / `${VAR}` in shell
scripts.

### `envvault ui`

An interactive terminal UI for the common operations, so you do not have to
remember flags.

```bash
envvault ui
```

From the menu you can:

- browse the secrets of the current environment, another project/environment,
  or the globals
- reveal a value on screen, or copy it to the clipboard
- set a new secret (name, hidden value, then choose the scope)
- delete a secret, with confirmation
- switch the current directory's project/environment
- enable and configure the sharing server, pick the shared keys, and create
  access tokens (choosing where the token is stored)
- lock the vault and exit

Values stay masked while browsing. Use ↑/↓ and Enter to choose, and Esc or
Ctrl+C to go back or cancel. It requires a real terminal, so it will not run
through a pipe or in CI.

---

## Sharing

EnvVault can expose **selected keys** to other machines over the network. It is
off by default: nothing listens until you enable it *and* run the server.

The model has two halves:

- **Selective shares** — a project/environment plus an allowlist of key names.
  The server encrypts those values with a key derived from a share token, so
  the response body is ciphertext. Note that this is **not** a substitute for
  TLS: the token itself is sent on every request, and it is the same secret the
  key is derived from. See [Use HTTPS](#use-https).
- **Encrypted backups** — `sync` uploads your `vault.enc` verbatim. The server
  stores opaque ciphertext it cannot read, and pulling restores it as-is.

### Enable and run

```bash
envvault share add crono/dev --keys DATABASE_URL,STRIPE_KEY --label "Crono dev"

envvault share token create --label laptop --shares all            # prints the token once
envvault share token create --label ci --shares crono/dev --backup --out ./ci-token

envvault server enable
envvault serve                                                     # listens on 127.0.0.1:8787
```

`envvault serve` refuses to start while sharing is disabled, and it will not
bind to the network until you ask it to:

```bash
envvault server host 0.0.0.0     # reachable from the LAN — warns before it does
envvault server port 9000
envvault server status
```

### Connect from another machine

```bash
envvault connect http://192.168.1.10:8787 --token <token> --list
envvault connect http://192.168.1.10:8787 --token <token> --share crono/dev --project app --env prod
envvault connect http://192.168.1.10:8787 --token <token> --global
```

Fetched keys are written into a scope you choose: `--global`, `--project <p>
--env <e>`, or `--project <p> --shared`. When run in a terminal with no scope
flags, it asks. Values are previewed masked and confirmed before anything is
written. The receiving vault's own master password is used to store them — the
remote server never learns it.

### Saved tokens

Once a token has been accepted, it is remembered for that server URL, so later
commands do not ask again:

```bash
envvault connect http://192.168.1.10:8787 --global      # reuses the saved token
envvault sync push http://192.168.1.10:8787 --id laptop # so does this

envvault tokens list                                    # what is saved, masked
envvault tokens remove http://192.168.1.10:8787         # forget one server
envvault tokens remove --all                            # forget everything
```

Tokens live in `~/.envvault/share-tokens.json` (mode `0600`) keyed by server
URL, and are only written after the server accepts them — a rejected token is
never saved. Opt out per command with `--no-save`, or entirely with
`ENVVAULT_NO_TOKEN_STORE=1`.

If several tokens are saved for one server (for example a read token and a
`--backup` token), `connect` asks which to use interactively and requires
`--token` when there is no terminal. `--token` and `ENVVAULT_SHARE_TOKEN`
always take precedence over the store.

Because a saved token is a bearer credential, anyone who can read the file as
your user can use it. That is the same access level `~/.envvault` already
assumes, but `envvault tokens remove` is the way to revoke it locally.

### Backups

```bash
envvault sync push http://192.168.1.10:8787 --token <token> --id laptop
envvault sync list http://192.168.1.10:8787 --token <token>
envvault sync pull http://192.168.1.10:8787 --token <token> --id laptop
```

A pull replaces the local vault, so it confirms first and keeps the previous
`vault.enc` as a `.bak-<timestamp>` file. Backups require a token created with
`--backup`.

### In the UI

`envvault ui` → **Sharing & server** shows the state, toggles sharing, sets the
bind address and port, adds or removes shares with a key picker, and creates
tokens — asking where the token should go (clipboard, a `0600` file, or on
screen). When sharing is on, the UI shows a notification for it at startup.

### How the encryption works

A share token is the only secret a client needs. The server derives an AES key
from it with scrypt and stores only that derived key plus the salt, next to the
vault it protects (`0600`). Each share response is an envelope encrypted with
that key, using the same AES-256-GCM scheme as the vault, so the payload body is
ciphertext. Only the allowlisted names are ever read from the vault.

The token is **not** encrypted though — it is a bearer credential sent in the
`Authorization` header on every request, and it is the same secret the payload
key is derived from. Encrypting the body therefore protects against a passive
observer reading *this* response, but not against one who captures the request:
with the token they can authenticate and derive the key themselves.

### Use HTTPS

Because of that, run the server behind TLS (a reverse proxy, or an SSH tunnel)
whenever it is reachable beyond loopback. Plain `http://` to a remote host sends
the token in the clear on every request.

`envvault connect` and `envvault sync` warn when you use `http://` against a
non-loopback host, for example:

```text
⚠ Warning: sending your share token unencrypted to http://ev.example.com.
If the server supports TLS, use https://ev.example.com instead.
```

A bare host defaults to `http://`, so pass the scheme explicitly when the server
speaks TLS:

```bash
envvault connect https://ev.example.com --token <token>
```

---

## Docker

Docker integration uses the installed Docker CLI. No Docker SDK is required.

### Compose

```bash
envvault docker compose up
envvault docker compose up -d
envvault docker compose build
envvault docker compose logs -f
envvault docker compose run backend bash
```

EnvVault resolves the vault, injects the variables into the Docker Compose
process environment, and Compose performs normal `${VAR}` interpolation. No
`.env` file is needed.

```yaml
# compose.yaml
services:
  backend:
    build: .
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      SECRET_KEY: ${SECRET_KEY}
```

### Run

```bash
envvault docker run --rm -p 8000:8000 my-image
envvault docker run --service backend my-image
envvault docker run --only DATABASE_URL,REDIS_URL my-image
envvault docker run --rm --only API_KEY python:3.12-alpine
```

Secrets are passed as `docker run --env NAME` — the value stays in the Docker
CLI's environment and never appears in argv or `ps` output.

EnvVault's own options (`--only`, `--service`, `--mode`) may appear before or
after Docker's arguments. If you need Docker to receive an argument that looks
like an EnvVault option, put `--` before the Docker arguments to pass the rest
through untouched.

### Plan

`envvault docker plan` performs a dry run and never reveals values. It exits
non-zero when a configured service is missing a required secret, which makes it
useful in CI.

```bash
envvault docker plan
```

```text
EnvVault Docker Plan

Project:
crono

Environment:
production

backend
  ✓ DATABASE_URL
  ✓ REDIS_URL
  ✓ SECRET_KEY

frontend
  ✓ PUBLIC_API_URL
  ✗ PUBLIC_API_KEY

4 secrets available
2 services configured

No secret values displayed.
```

### Least privilege

A `.envvault.json` in your project declares which secret names each service may
receive. This file never contains values.

```json
{
  "docker": {
    "mode": "env",
    "services": {
      "backend": ["DATABASE_URL", "REDIS_URL", "SECRET_KEY", "OPENAI_API_KEY"],
      "worker": ["DATABASE_URL", "REDIS_URL"],
      "frontend": ["PUBLIC_API_URL"]
    },
    "buildSecrets": ["NPM_TOKEN"]
  }
}
```

The `frontend` service above will never receive `SECRET_KEY` or
`OPENAI_API_KEY`, even though they exist in the vault.

### Compose secrets mode

Environment-backed Compose secrets work by injecting the backing variable into
the Compose process:

```yaml
services:
  backend:
    secrets:
      - db_password

secrets:
  db_password:
    environment: DATABASE_PASSWORD
```

```bash
envvault docker compose --mode secret up
```

Docker mounts the value at `/run/secrets/db_password`. EnvVault never writes a
persistent plaintext secret file.

### Build secrets

BuildKit secrets keep values out of image layers and build args:

```dockerfile
# Dockerfile
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) npm install
```

```bash
envvault docker build .
envvault docker build --only NPM_TOKEN .
```

The `id` is the lowercased secret name, and the value is read from the
environment variable of the same name. Secrets are passed through
`--secret id=<name>,env=<NAME>` and never through `--build-arg`.

---

## Security design

- **Authenticated encryption.** AES-256-GCM with a random 128-bit salt and a
  random 96-bit nonce per write. A wrong password or a modified file fails
  authentication and is reported the same way, so no information leaks.
- **Key derivation.** scrypt (N=2¹⁵, r=8, p=1) derives a 256-bit key from your
  master password. The password is never stored or logged.
- **Versioned envelope.** The encrypted file records its format version, KDF and
  cipher so the scheme can evolve without breaking existing vaults.
- **Atomic writes.** New ciphertext is written to a temporary file, fsynced, then
  renamed over `vault.enc`. A crash can never leave a half-written vault.
- **Strict separation.** Only `vault.enc` may contain secret values. Config,
  context and project files contain names and metadata only.
- **No accidental disclosure.** Values are masked everywhere by default;
  revealing requires `--reveal`. Docker values are passed by name, never by
  value. Plaintext export requires `--output` or an explicit format to stdout.
- **No code execution on import.** `.env` contents are parsed, never evaluated.
- **Hidden input.** Passwords and secret values are read without echoing.
- **File permissions.** `~/.envvault` is `0700`; vault, config, context and
  session files are `0600`; exported files are `0600`.
- **Unlock sessions are opt-in.** The cached key is written to disk only when
  you run `envvault unlock`, it expires on its own, and `envvault lock` removes
  it immediately. The master password itself is never stored.
- **Sharing is opt-in and encrypted end to end.** The server is disabled by
  default and binds loopback unless you opt into the network. Share responses
  are encrypted with a key derived from a per-token secret, so the response body
  is ciphertext. The token itself is a bearer credential sent per request, so
  put the server behind TLS before exposing it — see
  [Use HTTPS](#use-https). Only explicitly allowlisted key names are read,
  `server.json` holds names and token derivatives (never values and never raw
  tokens), and revoking a token takes effect on the next request.
- **Saved share tokens are opt-in per command.** A token that the server
  accepted is remembered in `~/.envvault/share-tokens.json` (`0600`) so you are
  only asked once per server. It is written after authentication succeeds, never
  on a rejection, and `--no-save` or `ENVVAULT_NO_TOKEN_STORE=1` keeps it off
  disk entirely.

### Vault format

The encrypted file is a self-describing JSON envelope. Base64 is only an
encoding for binary fields — never a substitute for encryption.

```json
{
  "version": 1,
  "kdf": "scrypt",
  "cipher": "aes-256-gcm",
  "salt": "…16 random bytes, base64…",
  "iv": "…12 random bytes, base64…",
  "tag": "…16-byte authentication tag, base64…",
  "ciphertext": "…encrypted vault, base64…"
}
```

`version` is checked before decrypting, so a file written by a newer EnvVault is
rejected with a clear message rather than decrypted incorrectly.

### Threat model

EnvVault protects secrets at rest (a stolen laptop, a synced backup, a copied
vault file) and keeps them out of shell history, process arguments, `.env`
files and Docker image layers. Like any tool that injects environment
variables, it cannot protect a secret from a compromised machine, a malicious
process running as your user, or a child process that chooses to log its own
environment.

### File locations

```text
~/.envvault/
├── vault.enc          encrypted secrets (safe to back up as ciphertext)
├── config.json        vault metadata
├── contexts.json      directory → project/environment mappings
├── metadata.json      timestamps
├── session.json       cached unlock key, present only while unlocked
├── server.json        sharing settings: shares (names only) + token derivatives
├── share-tokens.json  share tokens this device uses, keyed by server URL
└── backups/           encrypted vault copies uploaded with `envvault sync`
```

Only `vault.enc` contains secret values. It is safe to back up as-is; there is
no way to recover the contents without the master password, so keep that safe.
`server.json` and `backups/` hold no plaintext either: the former stores key
*names* and derived token keys, the latter stores encrypted envelopes.
`share-tokens.json` is the one deliberate exception — it stores the share tokens
you were given verbatim, because they must be replayed on every request. Treat
it like a password file.

### Non-interactive use

For CI and scripts, `ENVVAULT_MASTER_PASSWORD` supplies the master password so
no prompt is needed. See [Environment variables](#environment-variables) for the
details and caveats.

---

## Environment variables

| Variable | Effect |
| -------- | ------ |
| `ENVVAULT_HOME` | Override the vault directory (default `~/.envvault`). Useful for tests and CI. |
| `ENVVAULT_MASTER_PASSWORD` | Supply the master password non-interactively. Automation only — see below. |
| `ENVVAULT_MASTER_PASSWORD_FILE` | Path to a `0600` file containing the master password (useful for Docker/systemd secrets). |
| `ENVVAULT_NO_SESSION` | Ignore any unlock session and always prompt. |
| `ENVVAULT_SHARE_TOKEN` | Share token used by `envvault connect` and `envvault sync` instead of `--token`. |
| `ENVVAULT_NO_TOKEN_STORE` | Never read or write saved share tokens (`~/.envvault/share-tokens.json`). |
| `NO_COLOR` | Disable colored output. |

`ENVVAULT_MASTER_PASSWORD` skips the hidden prompt. It is intended for CI and
scripts, where no terminal is available:

```bash
ENVVAULT_MASTER_PASSWORD="$CI_VAULT_PASSWORD" envvault run -- npm test
```

Environment variables are visible to processes running as the same user, so use
it only where that is acceptable. Interactive use should rely on the prompt.

---

## Exit codes

| Code | Meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 1    | generic error                    |
| 2    | invalid usage                    |
| 3    | missing secret or configuration  |
| 4    | authentication / unlock failure  |
| 5    | Docker failure                   |
| 6    | network / server connection      |

`envvault run` and the `envvault docker` commands forward the child exit code.

---

## Development

```bash
npm install       # install dev dependencies
npm run dev -- --help
npm run check     # tsc --noEmit
npm test          # vitest run
npm run build     # tsup → dist/
```

The core CLI uses only Node's built-in modules. The interactive UI adds one
small runtime dependency, [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts).
The test suite uses an isolated vault home via `ENVVAULT_HOME`, so it never
touches `~/.envvault`.

### Project layout

```text
src/
├── cli.ts              CLI entry point and routing
├── index.ts            public programmatic API
├── commands/           one module per command
├── core/               crypto, vault, resolver, context, storage, config
├── docker/             run, compose, build, plan, secrets, config
├── env/                .env parser, serializer and source scanner
├── security/           masking, clipboard, memory hygiene
├── server/             sharing server: config, tokens, shares, HTTP, backup, client
└── utils/              fs, prompt, process, errors, args, output
```

### Programmatic API

```ts
import { resolveSecrets, loadVault } from "envvault";

const vault = await loadVault(process.env.HOME + "/.envvault", password);
const secrets = resolveSecrets(vault, { project: "crono", environment: "dev" });
```

---

## Limitations

- Sharing is opt-in and read-only for recipients: they can pull the keys a token
  grants, but cannot write back into the owner's vault. There is no merge or
  conflict resolution for shares.
- Saved share tokens are stored verbatim in `~/.envvault/share-tokens.json`
  (`0600`) because they must be replayed on each request. That is a deliberate
  convenience trade-off; use `--no-save` or `ENVVAULT_NO_TOKEN_STORE=1` for
  one-off, read-once use.
- A running `envvault serve` holds the derived vault key in memory and re-reads
  the encrypted vault per request. Anyone who can read its memory can read the
  vault — the same access level required to read `session.json`.
- Unlock sessions cache the derived key on disk (mode `0600`) until the TTL
  expires or `envvault lock` clears it — a deliberate convenience/security
  trade-off. Use a short TTL, or `ENVVAULT_NO_SESSION=1`, if that is not
  acceptable.
- Docker least privilege is enforced through `.envvault.json`; Compose
  interpolation is process-wide, so a variable referenced by one service is
  visible to the Compose process as a whole.
- Clipboard support depends on a platform tool (`pbcopy`, `clip`, `wl-copy`,
  `xclip` or `xsel`).

---

## Roadmap

- Unlock sessions with a secure, time-limited key cache.
- `envvault backup` and encrypted restore.
- Shared identity and rotation: short-lived tokens, per-token audit log.
- Machine/service identities for CI with read-only, per-environment scopes.
- Non-secret variable metadata and richer `.env.example` management.

---

## License

MIT
