// Saved sharing servers for remote control. Pure Node (no Electron import) so
// the rules are testable; main.cjs wires in Electron's safeStorage and paths.
//
// Tokens are stored encrypted with the OS keychain and only decrypted in the
// main process, where they are handed to a single CLI child as an environment
// variable. The renderer sees server names and URLs only.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const REMOTE_COMMANDS = new Set(['project', 'list', 'get', 'set', 'delete', 'export', 'import']);
const TOKEN_PREFIX = 'evt_';
const MAX_NAME = 60;

function normaliseServerUrl(input) {
  let value = String(input ?? '').trim();
  if (value === '') throw new Error('Enter the server URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error(`Not a valid server URL: ${input}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http:// or https:// server URL.');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function validateServerInput({ name, url, token }) {
  const cleanName = String(name ?? '').trim();
  if (cleanName === '' || cleanName.length > MAX_NAME) throw new Error(`Enter a server name of up to ${MAX_NAME} characters.`);
  const cleanToken = String(token ?? '').trim();
  if (!cleanToken.startsWith(TOKEN_PREFIX) || cleanToken.length < TOKEN_PREFIX.length + 16 || /\s/.test(cleanToken)) {
    throw new Error(`Enter a control token. Tokens start with "${TOKEN_PREFIX}".`);
  }
  return { name: cleanName, url: normaliseServerUrl(url), token: cleanToken };
}

/**
 * Build a store over one JSON file. `crypto` is `{ available(), encrypt(text),
 * decrypt(buffer) }`, which main.cjs backs with Electron's safeStorage.
 */
function createServerStore({ file, crypto }) {
  function readAll() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.servers) ? data.servers : [];
    } catch {
      return [];
    }
  }

  function writeAll(servers) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, servers }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  return {
    /** What the renderer may see: no tokens. */
    list() {
      return readAll().map(({ id, name, url }) => ({ id, name, url }));
    },

    save(input) {
      if (!crypto.available()) {
        throw new Error('Secure storage is unavailable on this system, so server tokens cannot be saved.');
      }
      const { name, url, token } = validateServerInput(input);
      const servers = readAll();
      const encrypted = crypto.encrypt(token).toString('base64');
      const existing = servers.find((server) => server.url === url);
      if (existing) {
        existing.name = name;
        existing.token = encrypted;
        writeAll(servers);
        return { id: existing.id, name, url };
      }
      const record = { id: randomUUID(), name, url, token: encrypted };
      servers.push(record);
      writeAll(servers);
      return { id: record.id, name, url };
    },

    remove(id) {
      const servers = readAll();
      const remaining = servers.filter((server) => server.id !== id);
      if (remaining.length !== servers.length) writeAll(remaining);
      return remaining.length !== servers.length;
    },

    /** Main-process only: the server with its decrypted token. */
    find(id) {
      const record = readAll().find((server) => server.id === id);
      if (!record) return null;
      return { id: record.id, name: record.name, url: record.url, token: crypto.decrypt(Buffer.from(record.token, 'base64')) };
    },
  };
}

/**
 * Rewrite a renderer request that targets a saved server into a `remote`
 * CLI request. Commands that need the local vault are refused, not sent.
 */
function resolveTargetRequest(request, store) {
  if (!request || request.target === undefined || request.target === null || request.target === '') {
    return request;
  }
  const command = Array.isArray(request.args) ? request.args[0] : undefined;
  if (!REMOTE_COMMANDS.has(command)) {
    throw new Error(`${command ?? 'This command'} runs against the local vault. Choose Local vault as the target first.`);
  }
  const server = store.find(request.target);
  if (!server) throw new Error('That server is no longer saved. Choose another target.');
  const { target, ...rest } = request;
  return { ...rest, args: ['remote', server.url, ...request.args], shareToken: server.token };
}

module.exports = { REMOTE_COMMANDS, createServerStore, normaliseServerUrl, resolveTargetRequest, validateServerInput };
