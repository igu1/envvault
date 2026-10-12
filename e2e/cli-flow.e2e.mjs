// End-to-end flow for the built CLI: separate processes, a real `envvault serve`,
// and the remote commands talking to it over HTTP. Run with `npm run e2e:cli`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');
const PASSWORD = 'e2e-master-password';
const home = mkdtempSync(join(tmpdir(), 'envvault-e2e-home-'));
const project = mkdtempSync(join(tmpdir(), 'envvault-e2e-project-'));
let server;
let port;
let controlToken;
let readToken;
let url;

function envvault(args, { input = '', env = {}, expectFail = false, cwd = project } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ENVVAULT_HOME: home,
      ENVVAULT_MASTER_PASSWORD: PASSWORD,
      NO_COLOR: '1',
      ...env,
    },
    timeout: 60000,
  });
  const out = { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (!expectFail) assert.equal(out.code, 0, `envvault ${args.join(' ')} failed:\n${out.stdout}\n${out.stderr}`);
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
}

async function waitForHealth(base) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Server still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('serve did not become healthy');
}

function remote(token, args, options = {}) {
  return envvault(['remote', url, ...args], { env: { ENVVAULT_SHARE_TOKEN: token, ENVVAULT_MASTER_PASSWORD: '' }, ...options });
}

describe('CLI end-to-end flow', { concurrency: false }, () => {
  before(async () => {
    assert.ok(statSync(cli).isFile(), 'build the CLI first: npm run build');
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
  });

  after(() => {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('initializes and stores globals separately from projects', () => {
    envvault(['init']);
    envvault(['project', 'add', 'crono', '--env', 'dev,prod']);
    envvault(['set', 'GLOBAL_KEY', '--stdin', '--global'], { input: 'global-value\n' });
    envvault(['set', 'DATABASE_URL', '--stdin', '--project', 'crono', '--env', 'dev'], { input: 'postgres://dev\n' });
    envvault(['set', 'SHARED_KEY', '--stdin', '--project', 'crono', '--shared'], { input: 'shared-value\n' });
  });

  it('shows globals only in the global scope', () => {
    const globals = JSON.parse(envvault(['list', '--global', '--json']).stdout);
    assert.deepEqual(globals.secrets.map(s => s.name), ['GLOBAL_KEY']);

    const dev = JSON.parse(envvault(['list', '--project', 'crono', '--env', 'dev', '--json']).stdout);
    assert.deepEqual(dev.secrets.map(s => s.name).sort(), ['DATABASE_URL', 'SHARED_KEY']);

    const exported = envvault(['export', '--format', 'json', '--project', 'crono', '--env', 'dev']).stdout;
    assert.ok(!exported.includes('GLOBAL_KEY'), 'globals must not be exported for a project');
  });

  it('injects only project keys into a run', () => {
    const script = 'console.log(process.env.GLOBAL_KEY ?? "ABSENT", process.env.DATABASE_URL)';
    const out = envvault(['run', '--quiet', '--project', 'crono', '--env', 'dev', '--', process.execPath, '-e', script]);
    assert.equal(out.stdout.trim(), 'ABSENT postgres://dev');
  });

  it('enables sharing, shares keys and issues a control token and a read-only token', () => {
    envvault(['server', 'enable']);
    envvault(['server', 'port', String(port)]);
    envvault(['server', 'host', '127.0.0.1']);
    envvault(['share', 'add', 'crono/dev', '--keys', 'DATABASE_URL,SHARED_KEY']);

    const control = envvault(['share', 'token', 'create', '--label', 'control', '--shares', 'all', '--control']).stdout;
    controlToken = control.match(/evt_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(controlToken, 'control token printed');

    const read = envvault(['share', 'token', 'create', '--label', 'reader', '--shares', 'all']).stdout;
    readToken = read.match(/evt_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(readToken, 'read token printed');
    assert.notEqual(controlToken, readToken);
  });

  it('starts the sharing server as a separate process', async () => {
    server = spawn(process.execPath, [cli, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: home, ENVVAULT_HOME: home, ENVVAULT_MASTER_PASSWORD: PASSWORD, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', () => {});
    await waitForHealth(url);
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.service, 'envvault');
  });

  it('lists and reads shares for a read-only token over the network', () => {
    const out = envvault(['connect', url, '--token', readToken, '--list', '--no-save']);
    assert.match(out.stdout, /crono\/dev/);
  });

  it('lists projects and scoped secrets remotely, without globals', () => {
    const projects = JSON.parse(remote(controlToken, ['project', 'list', '--json']).stdout);
    assert.equal(projects.projects[0].name, 'crono');

    const scoped = JSON.parse(remote(controlToken, ['list', '--project', 'crono', '--env', 'dev', '--json']).stdout);
    assert.ok(!scoped.secrets.some(s => s.name === 'GLOBAL_KEY'));
    assert.ok(scoped.secrets.some(s => s.name === 'DATABASE_URL'));

    const globals = JSON.parse(remote(controlToken, ['list', '--global', '--json']).stdout);
    assert.deepEqual(globals.secrets.map(s => s.name), ['GLOBAL_KEY']);
  });

  it('writes, reads and deletes a secret on the server vault', () => {
    remote(controlToken, ['set', 'REMOTE_KEY', '--stdin', '--project', 'crono', '--env', 'dev'], { input: 'remote-value\n' });

    // The server and the local CLI share one vault, so the local view proves the write landed.
    const local = envvault(['list', '--project', 'crono', '--env', 'dev', '--json']).stdout;
    assert.ok(local.includes('REMOTE_KEY'));

    assert.equal(remote(controlToken, ['get', 'REMOTE_KEY', '--raw', '--project', 'crono', '--env', 'dev']).stdout.trim(), 'remote-value');

    remote(controlToken, ['delete', 'REMOTE_KEY', '--yes', '--project', 'crono', '--env', 'dev']);
    assert.ok(!envvault(['list', '--project', 'crono', '--env', 'dev', '--json']).stdout.includes('REMOTE_KEY'));
  });

  it('exports and imports remotely', () => {
    const exported = remote(controlToken, ['export', '--format', 'env', '--project', 'crono', '--env', 'dev']).stdout;
    assert.match(exported, /DATABASE_URL=postgres:\/\/dev/);
    assert.ok(!exported.includes('GLOBAL_KEY'));

    writeFileSync(join(project, 'import.env'), 'IMPORTED=yes\nDATABASE_URL=overwritten\n');
    const result = remote(controlToken, ['import', 'import.env', '--project', 'crono', '--env', 'dev']).stdout;
    assert.match(result, /Imported 1 secret/);
    assert.match(result, /Skipped 1 existing key/);
    assert.ok(envvault(['list', '--project', 'crono', '--env', 'dev', '--json']).stdout.includes('IMPORTED'));
    assert.equal(
      envvault(['get', 'DATABASE_URL', '--raw', '--project', 'crono', '--env', 'dev']).stdout.trim(),
      'postgres://dev',
    );
  });

  it('manages projects and environments remotely', () => {
    remote(controlToken, ['project', 'add', 'atlas', '--env', 'staging']);
    assert.match(envvault(['project', 'list']).stdout, /atlas/);
    remote(controlToken, ['project', 'remove', 'atlas', '--yes']);
    assert.doesNotMatch(envvault(['project', 'list']).stdout, /atlas/);
  });

  it('refuses a read-only token for control, and a bogus token entirely', () => {
    const denied = remote(readToken, ['list', '--global'], { expectFail: true });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /not allowed to control the vault/);

    const bogus = `evt_${'x'.repeat(43)}`;
    const rejected = remote(bogus, ['list', '--global'], { expectFail: true });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /share token|token/i);
  });

  it('keeps secret values out of plaintext on disk', () => {
    const offenders = [];
    const walk = dir => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry !== 'vault.enc' && !entry.endsWith('.bak') && !entry.startsWith('vault.enc.bak')) {
          const text = readFileSync(path, 'utf8');
          if (['postgres://dev', 'shared-value', 'global-value', 'remote-value'].some(v => text.includes(v))) offenders.push(path);
        }
      }
    };
    walk(home);
    assert.deepEqual(offenders, []);
  });

  it('stops the server cleanly', async () => {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    await assert.rejects(fetch(`${url}/health`));
  });
});
