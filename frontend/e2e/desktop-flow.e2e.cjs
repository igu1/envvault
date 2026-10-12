// Full desktop flow in the real Electron app, driven through Playwright.
// Run with `npm run e2e` in frontend (Linux: wrapped in xvfb-run).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, existsSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const frontend = path.join(__dirname, '..');
const repo = path.join(frontend, '..');
const cli = path.join(repo, 'dist', 'cli.js');
const PASSWORD = 'e2e-master-password';
const home = mkdtempSync(path.join(tmpdir(), 'envvault-desktop-home-'));
const userData = mkdtempSync(path.join(tmpdir(), 'envvault-desktop-data-'));
const project = mkdtempSync(path.join(tmpdir(), 'envvault-desktop-cwd-'));
const cliEnv = { ...process.env, ENVVAULT_HOME: home, ENVVAULT_MASTER_PASSWORD: PASSWORD, NO_COLOR: '1' };
let app;
let page;
let serveProcess;
let port;
let controlToken;
let readToken;
let secureStoreMode = 'os';

function envvault(args, input = '', extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, input, encoding: 'utf8', env: { ...cliEnv, ...extraEnv }, timeout: 60000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
}

async function waitFor(check, label, timeout = 20000) {
  const started = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // Keep polling until the timeout.
    }
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

const tabs = () => page.$$eval('#scope-tabs button', nodes => nodes.map(node => node.textContent.trim()));
const rows = () => page.$$eval('#secret-rows tr td:first-child', nodes => nodes.map(node => node.textContent.trim()));

async function addSecret(name, value) {
  await page.click('button[data-action="new-secret"]');
  await page.fill('#key', name);
  await page.fill('#value', value);
  await page.click('#secret-form button[type="submit"]');
  await waitFor(async () => !(await page.isVisible('#secret-dialog')), `secret ${name} saved`);
  await waitFor(async () => (await rows()).includes(name), `${name} listed`);
}

async function saveServer(name, url, token) {
  await page.click('button[data-view="servers"]');
  await page.fill('#server-name', name);
  await page.fill('#server-url', url);
  await page.fill('#server-token', token);
  await page.click('#server-form button[type="submit"]');
}

async function reconnectLocal() {
  await page.fill('#password', PASSWORD);
  await page.click('#access-form button[type="submit"]');
  await waitFor(async () => (await page.textContent('#connection-state')) === 'Vault connected', 'local vault reconnected');
}

before(async () => {
  port = await freePort();
  // EV_E2E_APP=packaged runs the installed build (bundled CLI in resources/cli).
  const packaged = process.env.EV_E2E_APP === 'packaged';
  app = await electron.launch({
    ...(packaged ? { executablePath: process.env.EV_E2E_EXECUTABLE } : { args: [frontend] }),
    args: [...(packaged ? [] : [frontend]), `--user-data-dir=${userData}`, '--no-sandbox'],
    cwd: frontend,
    env: { ...cliEnv },
    timeout: 60000,
  });
  page = await app.firstWindow();
  page.on('dialog', dialog => dialog.accept());
  await page.waitForFunction(() => window.envvault && document.getElementById('target-select'), null, { timeout: 30000 });
});

after(async () => {
  if (serveProcess && serveProcess.exitCode === null) serveProcess.kill('SIGTERM');
  if (app) await app.close().catch(() => {});
  for (const dir of [home, userData, project]) rmSync(dir, { recursive: true, force: true });
});

test('security: the renderer has no Node access', async () => {
  const nodeAccess = await page.evaluate(() => ({ require: typeof require, process: typeof process }));
  assert.deepEqual(nodeAccess, { require: 'undefined', process: 'undefined' });
});

test('initialize and connect the local vault from Vault access', async () => {
  await page.click('button[data-action="access"].nav-item');
  await page.fill('#password', PASSWORD);
  await page.click('button[data-action="init"]');
  await waitFor(async () => (await page.textContent('#connection-state')) === 'Vault connected', 'vault connected after init');
  assert.ok(existsSync(path.join(home, 'vault.enc')), 'vault.enc created by the CLI');
});

test('create a project with two environments from the dashboard', async () => {
  await page.click('button[data-action="new-project"]');
  await page.fill('#project', 'crono');
  await page.fill('#environment', 'dev,prod');
  await page.click('#project-form button[type="submit"]');
  await waitFor(async () => (await page.$$('.project-card')).length === 1, 'project card rendered');
  assert.match(envvault(['project', 'list']).stdout, /crono/);
});

test('globals live in the Global scope and are the only scope with no project', async () => {
  await page.click('button[data-action="global"]');
  await waitFor(async () => (await tabs()).join() === 'Global', 'only the Global tab without a project');
  await addSecret('GLOBAL_KEY', 'global-value');
  assert.deepEqual(await rows(), ['GLOBAL_KEY']);
});

test('selecting a project hides globals; project and environment keys stay separate', async () => {
  await page.click('button.environment-button[data-project="crono"][data-environment="dev"]');
  await waitFor(async () => (await tabs()).join('|') === 'Project shared|dev|prod', 'project tabs without Global');
  await addSecret('DATABASE_URL', 'postgres://dev');
  assert.deepEqual(await rows(), ['DATABASE_URL'], 'globals must not appear in a project view');
  const dev = JSON.parse(envvault(['list', '--project', 'crono', '--env', 'dev', '--json']).stdout);
  assert.deepEqual(dev.secrets.map(secret => secret.name), ['DATABASE_URL']);
});

test('reveal a project secret and see its stored value', async () => {
  await page.click('button[data-action="reveal"][data-key="DATABASE_URL"]');
  await waitFor(async () => (await page.textContent('#secret-rows')).includes('postgres://dev'), 'revealed value');
});

test('share the environment and start the sharing server as a separate process', async () => {
  assert.equal(envvault(['server', 'enable']).code, 0);
  assert.equal(envvault(['server', 'port', String(port)]).code, 0);
  assert.equal(envvault(['server', 'host', '127.0.0.1']).code, 0);
  assert.equal(envvault(['share', 'add', 'crono/dev', '--keys', 'DATABASE_URL']).code, 0);
  controlToken = envvault(['share', 'token', 'create', '--label', 'desktop', '--shares', 'all', '--control']).stdout.match(/evt_[A-Za-z0-9_-]+/)[0];
  readToken = envvault(['share', 'token', 'create', '--label', 'reader', '--shares', 'all']).stdout.match(/evt_[A-Za-z0-9_-]+/)[0];

  serveProcess = spawn(process.execPath, [cli, 'serve', '--host', '127.0.0.1', '--port', String(port)], { cwd: project, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  serveProcess.stderr.on('data', () => {});
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'sharing server healthy');
});

test('the real OS secure store is checked before any server token is saved', async () => {
  const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  if (available) {
    secureStoreMode = 'os';
    return;
  }
  // This machine has no keychain: saving must be refused, with the reason shown.
  secureStoreMode = 'test-cipher';
  await saveServer('home', `http://127.0.0.1:${port}`, controlToken);
  await waitFor(async () => (await page.textContent('#server-error')).includes('Secure storage is unavailable'), 'refusal shown');
  assert.equal(readFileSystemExists(path.join(userData, 'servers.json')), false, 'no token file written when storage is unavailable');
  // Stand in a reversible cipher for the keychain so the rest of the flow can run.
  await app.evaluate(({ safeStorage }) => {
    const key = 0x5a;
    const xor = buffer => Buffer.from(buffer.map(byte => byte ^ key));
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = text => xor(Buffer.from(text, 'utf8'));
    safeStorage.decryptString = buffer => xor(buffer).toString('utf8');
  });
});

function readFileSystemExists(file) {
  return existsSync(file);
}

test('add the server; the token is stored encrypted and never rendered', async () => {
  await saveServer('home', `http://127.0.0.1:${port}`, controlToken);
  await waitFor(async () => (await page.textContent('#server-list')).includes('home'), 'server listed');
  const listed = await page.textContent('#server-list');
  assert.ok(!listed.includes(controlToken), 'token must not be rendered');
  const stored = readFileSync(path.join(userData, 'servers.json'), 'utf8');
  assert.ok(!stored.includes(controlToken), 'token must not be stored in plaintext');
  assert.match(stored, /"url"/);
  if (secureStoreMode === 'test-cipher') assert.match(page.url(), /index\.html/);
});

test('switch the target to the server and see its projects', async () => {
  await page.click('button[data-view="overview"]');
  const serverId = await page.$$eval('#target-select option', options => options.find(option => option.text.startsWith('home')).value);
  await page.selectOption('#target-select', serverId);
  await waitFor(async () => (await page.textContent('#connection-state')) === 'Server: home', 'connected to server');
  await waitFor(async () => (await page.$$('.project-card')).length === 1, 'server project card');
  await page.click('button.environment-button[data-project="crono"][data-environment="dev"]');
  await waitFor(async () => (await rows()).includes('DATABASE_URL'), 'server secrets listed');
  assert.deepEqual(await rows(), ['DATABASE_URL'], 'server view has no globals');
});

test('write a secret on the server from the UI and verify it in the server vault', async () => {
  await addSecret('REMOTE_KEY', 'remote-value');
  const local = envvault(['list', '--project', 'crono', '--env', 'dev', '--json']).stdout;
  assert.ok(local.includes('REMOTE_KEY'), 'server write landed in the vault');
  assert.equal(envvault(['get', 'REMOTE_KEY', '--raw', '--project', 'crono', '--env', 'dev']).stdout.trim(), 'remote-value');
});

test('local-only features are disabled while a server is the target', async () => {
  await page.click('button[data-view="execution"]');
  await waitFor(async () => page.isVisible('#operation-run'), 'run form visible');
  assert.equal(await page.$eval('#operation-run button[type="submit"]', button => button.disabled), true);
  await page.click('button[data-view="overview"]');
});

test('a read-only token is refused for control with a clear message', async () => {
  // localhost is a different URL string, so this is a separate saved server entry.
  await saveServer('reader', `http://localhost:${port}`, readToken);
  await waitFor(async () => (await page.textContent('#server-list')).includes('reader'), 'reader saved');
  const readerId = await page.$$eval('#target-select option', options => options.find(option => option.text.startsWith('reader')).value);
  await page.selectOption('#target-select', readerId);
  await waitFor(async () => (await page.textContent('#output')).includes('not allowed to control the vault'), 'refusal shown');
  await page.selectOption('#target-select', '');
  // Switching back clears the password and asks for it again.
  await waitFor(async () => page.isVisible('#access-dialog'), 'access dialog for local vault');
  await reconnectLocal();
});

test('return to the local vault and forget the server', async () => {
  await page.click('button[data-view="servers"]');
  const row = page.locator('.server-row', { hasText: 'reader' });
  await row.locator('button', { hasText: 'Remove' }).click();
  await waitFor(async () => !(await page.textContent('#server-list')).includes('reader'), 'reader removed');
  const remaining = await page.$$eval('#target-select option', options => options.map(option => option.text));
  assert.ok(remaining.includes('home · server'), 'home server still saved');
  assert.ok(!remaining.some(text => text.startsWith('reader')), 'reader gone from targets');
});

test('lock the vault and the CLI can no longer read it without a password', async () => {
  // Already on the local vault from the previous test.
  assert.equal(await page.inputValue('#target-select'), '');
  await waitFor(async () => (await page.textContent('#connection-state')) === 'Vault connected', 'local vault connected');
  await page.click('button[data-action="lock"]');
  await waitFor(async () => (await page.textContent('#connection-state')) === 'Not connected', 'locked');
  const after = envvault(['list', '--project', 'crono', '--env', 'dev', '--json'], '', { ENVVAULT_MASTER_PASSWORD: '' });
  assert.notEqual(after.code, 0, 'locked vault must not be readable without a password');
});
