const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { runCommand } = require('./runner.cjs');

test('CLI bridge validates requests and manages an isolated vault', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'envvault-desktop-test-'));
  const previous = process.env.ENVVAULT_HOME;
  process.env.ENVVAULT_HOME = path.join(home, '.envvault');
  const request = { cwd: home, password: 'test-password-123', input: '' };
  const run = (args, input = '') => runCommand({ ...request, args, input });
  try {
    await assert.rejects(run(['ui']), /embedded terminal/);
    await assert.rejects(run(['list', null]), /supported/);
    await assert.rejects(runCommand({ ...request, args: ['list'], cwd: 'relative' }), /directory/);
    assert.equal((await run(['init'])).code, 0);
    assert.equal((await run(['project', 'add', 'demo', '--env', 'dev'])).code, 0);
    assert.equal((await run(['project', 'add', 'demo', '--env', 'production'])).code, 0);
    const scope = ['--project', 'demo', '--env', 'dev'];
    const secret = 'literal $(echo unsafe); & <value>\nsecond line';
    assert.equal((await run(['set', 'GITHUB_TOKEN', '--stdin', '--global'], 'global-value\n')).code, 0);
    assert.equal((await run(['set', 'TOKEN', '--stdin', '--project', 'demo', '--shared'], 'shared-value\n')).code, 0);
    assert.equal((await run(['set', 'TOKEN', '--stdin', ...scope], secret + '\n')).code, 0);
    const masked = await run(['list', ...scope]);
    assert.equal(masked.code, 0);
    assert.match(masked.stdout, /TOKEN/);
    assert.ok(!masked.stdout.includes(secret));
    const overview = await run(['project', 'list', '--json']);
    assert.deepEqual(JSON.parse(overview.stdout), {
      globalSecretCount: 1,
      projects: [{ name: 'demo', sharedSecretCount: 1, environments: [
        { name: 'dev', secretCount: 1 }, { name: 'production', secretCount: 0 },
      ] }],
    });
    const metadata = await run(['list', '--json', ...scope]);
    assert.deepEqual(JSON.parse(metadata.stdout), { scope: 'demo / dev', secrets: [
      { name: 'GITHUB_TOKEN', origin: 'global' }, { name: 'TOKEN', origin: 'environment' },
    ] });
    assert.ok(!overview.stdout.includes(secret));
    assert.ok(!metadata.stdout.includes(secret));
    assert.ok(!metadata.stdout.includes('global-value'));
    assert.ok(!metadata.stdout.includes('shared-value'));
    assert.deepEqual(JSON.parse((await run(['list', '--json', '--project', 'demo', '--env', 'production'])).stdout).secrets, [
      { name: 'GITHUB_TOKEN', origin: 'global' }, { name: 'TOKEN', origin: 'project' },
    ]);
    assert.equal((await run(['get', 'TOKEN', '--raw', ...scope])).stdout.trimEnd(), secret);
    assert.deepEqual(JSON.parse((await run(['export', '--format', 'json', ...scope])).stdout), { GITHUB_TOKEN: 'global-value', TOKEN: secret });
    assert.match((await run(['export', '--format', 'env', ...scope])).stdout, /GITHUB_TOKEN=global-value/);
    const csv = path.join(home, 'secrets.csv');
    assert.equal((await run(['export', '--format', 'csv', '--output', csv, ...scope])).code, 0);
    assert.equal(await readFile(csv, 'utf8'), `name,value\r\n"GITHUB_TOKEN","global-value"\r\n"TOKEN","${secret}"\r\n`);
    if (process.platform !== 'win32') assert.equal((await stat(csv)).mode & 0o777, 0o600);
    const failed = await runCommand({ ...request, password: 'wrong-password', args: ['list'] });
    assert.notEqual(failed.code, 0);
    assert.ok(!failed.stderr.includes('test-password-123'));
    assert.equal((await run(['delete', 'TOKEN', '--yes', ...scope])).code, 0);
    assert.equal((await run(['get', 'TOKEN', '--raw', ...scope])).stdout.trimEnd(), 'shared-value');
    assert.equal((await run(['delete', 'TOKEN', '--yes', '--project', 'demo', '--shared'])).code, 0);
    assert.notEqual((await run(['get', 'TOKEN', ...scope])).code, 0);
  } finally {
    if (previous === undefined) delete process.env.ENVVAULT_HOME;
    else process.env.ENVVAULT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
