FROM node:20-alpine

WORKDIR /app

# BuildKit secret: the token never lands in an image layer or a build arg.
# The id is the lowercased EnvVault secret name (NPM_TOKEN -> npm_token).
# Run this build with: envvault docker build .
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN="$(cat /run/secrets/npm_token)" \
    sh -c 'test -n "$NPM_TOKEN" && echo "authenticated as $NPM_TOKEN"'

COPY app.js ./

CMD ["node", "app.js"]
