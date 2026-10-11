# EnvVault desktop

Standalone Electron frontend that executes this repository's `dist/cli.js`.
It shares the CLI's existing vault and directory mappings; there is no second
secret store or backend. Node.js 20+ **on PATH** and a graphical desktop are
required. Docker workflows additionally require Docker/Compose. `node-pty`
may require your platform's C++ build tools if a prebuilt binary is unavailable.

```bash
cd frontend
npm install
npm start
```

`npm start` builds the parent CLI first (run `npm install` in the repository
root once). Open **Vault access**, choose a working directory, and connect
with your master password or an existing CLI unlock session. An existing
session automatically loads the dashboard on launch.

The terminal-inspired dashboard uses a dark monospace interface, a project
tree, compact environment panels, and a metadata session readout. An embedded
xterm terminal runs actual CLI processes through a native PTY.

The dashboard shows every project, its environments, shared keys, and real
stored-secret counts. Search projects or environments, then select an
environment to explore resolved secrets and their origins. Global keys and
project-shared keys are separate scopes. Add projects/environments, edit
secrets, reveal or copy values, and bind the working directory from the UI.
Deleting an inherited secret explicitly confirms its original scope, because
that deletion can affect other environments. Refresh reloads CLI-side changes.

The dashboard uses `envvault project list --json` for counts and structure
and `envvault list --json` for secret names and origins. Neither JSON output
contains secret values. Plaintext is fetched only for an explicit reveal,
copy, or export operation.

The secret explorer and each project card provide **Reveal all / Hide all**,
**Copy all**, **Export .env**, **Export CSV**, and **Export JSON**. Project cards have a bulk-action
scope selector; environment actions include inherited global/shared keys with
environment overrides. Reveal opens the explorer. All bulk actions include keys
hidden by search. Copy produces .env text and clears the clipboard after 30 seconds
if unchanged. Exports use a save dialog and write plaintext files with 0600 permissions.
CSV preserves exact values; import columns as text to avoid spreadsheet formula evaluation.

## CLI feature coverage

| Area | Electron controls |
| --- | --- |
| Vault | Initialize, connect, configurable unlock TTL, lock |
| Projects and keys | Projects/environments, global/shared/environment scopes, set/get/list/delete/copy |
| Vault tools | Import with overwrite, env/JSON/CSV/shell export, doctor/strict, use/unuse, clipboard timeout |
| Execution | Injected run, Docker run/Compose/BuildKit/plan, service/key allowlists and Compose mode |
| Sharing | Server status/enable/disable/host/port, live serve, share list/add/remove, token list/create/revoke and grants |
| Remote | Connect list/preview/import with explicit targets, encrypted sync list/push/pull/remove, saved token list/remove/all |
| Terminal | Original `envvault ui`, every CLI command and flag, interactive prompts, stdin, Ctrl+C, resize, stop |

The command panel also exposes all commands and flags directly. Put
each argument on its own line, without shell quotes. For example, importing
a file with spaces uses command `import` and one argument `my secrets.env`.
To save a secret through the panel, use `set`, arguments `NAME` and `--stdin`
on separate lines, and supply the value as standard input. Commands needing
terminal prompts can use the **Run in a live interactive terminal** checkbox.
`ui`, `serve`, `run`, CLI `copy`, and Docker execution automatically use a live terminal.
Dashboard/Tools copying uses the native clipboard; clipboard commands inside
the original terminal UI still use the CLI's platform clipboard tools.

Buffered commands have a 60-second timeout and a 1 MiB output limit. Live
terminals have no timeout and support up to four open panes/concurrent processes. Output
is streamed with backpressure and a 1,000-line scrollback. The original `ui`
is exclusive because it keeps a decrypted vault snapshot in memory: stop it
before using dashboard controls. Refresh reloads its changes afterward.

Choose an environment before a Docker execution if the directory is not
bound; the GUI confirms and binds it before launch. Stop terminates the owned
process tree but does not remove detached Docker containers. Closing/reloading
the window or locking the vault stops embedded processes. The PTY addon runs
in a system-Node helper, avoiding an Electron-native ABI rebuild.

Passwords are passed only to the CLI child environment; secret values use
stdin. The frontend doesn't save credentials, command history, or output.
Remote tokens are passed in the child environment rather than command-line
arguments. Remote forms default to not saving tokens; uncheck that option to
use the CLI's normal credential store. A backup pull stops embedded processes
and requires reconnection with the restored vault's password.

An explicit `unlock` still creates the CLI's normal on-disk session. Lock
clears that session, owned clipboard content, and sensitive UI fields. Copy
uses Electron's native clipboard and only clears it if the content is unchanged.
Owned clipboard content is also cleared on lock/window close, including when
automatic timeout clearing is disabled.
Plaintext reveals, exports,
and custom program output can contain secrets; clear the output afterward.
Only local content is loaded, with a sandboxed renderer and narrow IPC bridge.
Inline styles are permitted for xterm's generated styles; inline scripts,
remote content, and renderer network requests remain blocked.

```bash
npm test
```

Tests use an isolated temporary vault, never your real vault. Desktop
installers and packaging are not included.
