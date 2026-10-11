const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServerStore, normaliseServerUrl, resolveTargetRequest, validateServerInput } = require('./servers.cjs');

const TOKEN = 'evt_' + 'a'.repeat(43);
const fakeCrypto = {
  available: () => true,
  encrypt: text => Buffer.from(`sealed:${text}`),
  decrypt: buffer => buffer.toString().replace(/^sealed:/, ''),
};

function tempStore(crypto = fakeCrypto) {
  const dir = mkdtempSync(path.join(tmpdir(), 'envvault-servers-'));
  const file = path.join(dir, 'servers.json');
  return { file, dir, store: createServerStore({ file, crypto }) };
}

test('server URLs are normalised to http(s) origins without trailing slashes', () => {
  assert.equal(normaliseServerUrl('vault.local:8787/'), 'http://vault.local:8787');
  assert.equal(normaliseServerUrl('https://ev.example.com/base///'), 'https://ev.example.com/base');
  assert.throws(() => normaliseServerUrl('ftp://example.com'), /http/);
  assert.throws(() => normaliseServerUrl('   '), /Enter the server URL/);
});

test('server input requires a name and an EnvVault token shape', () => {
  assert.throws(() => validateServerInput({ name: '', url: 'x', token: TOKEN }), /server name/);
  assert.throws(() => validateServerInput({ name: 'home', url: 'x', token: 'not-a-token' }), /Enter a control token/);
  assert.deepEqual(validateServerInput({ name: ' home ', url: '127.0.0.1:8787', token: ` ${TOKEN} ` }), {
    name: 'home',
    url: 'http://127.0.0.1:8787',
    token: TOKEN,
  });
});

test('saved tokens are encrypted on disk and never listed to the renderer', () => {
  const { file, dir, store } = tempStore();
  try {
    const saved = store.save({ name: 'home', url: 'http://127.0.0.1:8787', token: TOKEN });
    assert.deepEqual(store.list(), [{ id: saved.id, name: 'home', url: 'http://127.0.0.1:8787' }]);
    assert.ok(!readFileSync(file, 'utf8').includes(TOKEN), 'plaintext token must not reach disk');
    assert.equal(store.find(saved.id).token, TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving the same URL updates the existing entry instead of duplicating it', () => {
  const { dir, store } = tempStore();
  try {
    const first = store.save({ name: 'home', url: 'http://h:1', token: TOKEN });
    const second = store.save({ name: 'renamed', url: 'http://h:1', token: TOKEN });
    assert.equal(second.id, first.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].name, 'renamed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tokens are refused when secure storage is unavailable', () => {
  const { dir, store } = tempStore({ ...fakeCrypto, available: () => false });
  try {
    assert.throws(() => store.save({ name: 'home', url: 'http://h:1', token: TOKEN }), /Secure storage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a server forgets its token', () => {
  const { dir, store } = tempStore();
  try {
    const saved = store.save({ name: 'home', url: 'http://h:1', token: TOKEN });
    assert.equal(store.remove(saved.id), true);
    assert.equal(store.remove(saved.id), false);
    assert.equal(store.find(saved.id), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local requests pass through untouched', () => {
  const request = { args: ['list', '--json', '--global'], cwd: '/tmp', target: null };
  assert.equal(resolveTargetRequest(request, { find: () => null }), request);
});

test('remote requests become CLI remote calls carrying the token only in shareToken', () => {
  const { dir, store } = tempStore();
  try {
    const saved = store.save({ name: 'home', url: 'http://h:1', token: TOKEN });
    const resolved = resolveTargetRequest(
      { args: ['set', 'API_KEY', '--stdin', '--project', 'crono', '--env', 'dev'], cwd: '/tmp', password: '', input: 'v', target: saved.id, shareToken: '' },
      store,
    );
    assert.deepEqual(resolved.args, ['remote', 'http://h:1', 'set', 'API_KEY', '--stdin', '--project', 'crono', '--env', 'dev']);
    assert.equal(resolved.shareToken, TOKEN);
    assert.ok(!resolved.args.includes(TOKEN));
    assert.equal(resolved.target, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local-only commands are refused for a remote target', () => {
  const { dir, store } = tempStore();
  try {
    const saved = store.save({ name: 'home', url: 'http://h:1', token: TOKEN });
    for (const command of ['run', 'docker', 'serve', 'sync', 'init', 'lock', 'use']) {
      assert.throws(
        () => resolveTargetRequest({ args: [command], cwd: '/tmp', target: saved.id }, store),
        /runs against the local vault/,
        command,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale server id fails clearly instead of falling back to local', () => {
  const { dir, store } = tempStore();
  try {
    assert.throws(
      () => resolveTargetRequest({ args: ['list'], cwd: '/tmp', target: 'missing' }, store),
      /no longer saved/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
