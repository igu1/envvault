# Contributing

Thanks for taking the time to contribute. This document covers the essentials.

## Getting started

```bash
git clone https://github.com/igu1/envvault.git
cd envvault
npm install
npm run dev -- --help     # run the CLI from source via tsx
```

Node.js 20 or newer is required (see `.nvmrc`).

## Scripts

| Script | What it does |
| ------ | ------------ |
| `npm run dev -- <args>` | Run the CLI from source with `tsx` |
| `npm run check` | Type-check everything (`tsc --noEmit`) |
| `npm test` | Run the test suite (`vitest run`) |
| `npm run build` | Bundle to `dist/` with `tsup` |
| `npm run prepublishOnly` | check + test + build (runs on `npm publish`) |

Before opening a pull request, make sure `npm run check`, `npm test` and
`npm run build` all pass.

## Project layout

```text
src/
├── cli.ts        argument parsing and command routing
├── index.ts      public programmatic API (keep it small and stable)
├── commands/     one module per command
├── core/         crypto, vault, resolver, context, storage, config, session
├── docker/       run, compose, build, plan, secrets, config
├── env/          .env parser, serializer and source scanner
├── security/     masking, clipboard, memory hygiene
├── server/       sharing server: config, tokens, shares, HTTP, backup, client
└── utils/        fs, prompt, process, errors, args, output
```

## Guidelines

### Dependencies

The runtime dependency budget is deliberately tight: the core CLI uses **only
Node built-ins**, and the interactive UI adds one small package,
`@clack/prompts`. Please open an issue before adding a new runtime dependency.

### Architecture

- Commands are thin. Put logic in `core/` or `server/` so it can be tested
  directly and reused by the UI.
- `Core`/`server` modules never touch `process` directly. Everything a command
  needs from the outside world arrives through `AppContext` (`io`, `clipboard`,
  `env`, `cwd`, `home`). This keeps commands deterministic and testable.
- Prefer pure functions over `VaultData` (see `core/resolver.ts`,
  `core/vault.ts`) so precedence rules stay easy to reason about.
- Surface failures as an `EnvVaultError` subclass with a message and, where
  useful, a hint. Add an exit code if a new category is needed.

### Security invariants

Do not weaken these; see `SECURITY.md` for the full list.

- Only `vault.enc` may contain secret values. Everything else stores names.
- Never write the master password to disk, logs or child processes.
- Never persist a raw share token; store the derived key and salt only.
- Mask values by default; require an explicit flag to reveal them.
- Keep the sharing server opt-in, loopback by default, and read only
  allowlisted key names.

### Tests

- Tests live in `test/` and run through `vitest`.
- Use the harness in `test/helpers.ts`. It points `ENVVAULT_HOME` at a temporary
  directory, so tests never touch a real `~/.envvault`.
- Add a test for every behaviour change. Bug fixes should come with a regression
  test that fails before the fix.
- Server tests bind to port `0` and talk to the server over `fetch`, so they use
  an ephemeral port and never collide.

```bash
npm test                       # everything
npx vitest run test/serve.test.ts   # one file
```

### Style

Match the surrounding code: two-space indentation, explicit return types on
exported functions, `import type` for type-only imports, and JSDoc on modules
and non-obvious functions. Keep comments about *why*, not *what*.

## Commits and pull requests

- Write focused commits with an imperative subject line, for example
  `add share token revocation`.
- Describe the motivation in the pull request, list the commands affected, and
  note any security-relevant change.
- Update `README.md` for user-visible changes and add an entry under
  `## [Unreleased]` in `CHANGELOG.md`.
