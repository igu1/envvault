## Summary

<!-- What changed and why. Link any related issue. -->

## Affected commands

<!-- For example: envvault set, envvault share, envvault serve -->

## Checklist

- [ ] `npm run check` passes
- [ ] `npm test` passes (with tests added for the change)
- [ ] `npm run build` passes
- [ ] No new runtime dependency without prior discussion
- [ ] Security invariants are preserved (only `vault.enc` holds values; no raw
      token or password is ever persisted)
- [ ] `README.md` updated for user-visible changes
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
