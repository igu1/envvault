# EnvVault examples

Small, self-contained examples used by the documentation.

| File | Purpose |
| ---- | ------- |
| `.env.example` | A sample `.env` to import with `envvault import .env`. |
| `.envvault.json` | Project config with per-service Docker allowlists (no values). |
| `compose.yaml` | Compose stack that interpolates EnvVault variables. |
| `Dockerfile` | Shows BuildKit secret usage for `envvault docker build`. |
| `app.js` | Node.js program that reads injected variables. |

Try it:

```bash
cp .env.example .env
envvault project add example --env dev
envvault use example/dev
envvault import .env

envvault list
envvault run -- node app.js

envvault docker plan
envvault docker compose up
```
