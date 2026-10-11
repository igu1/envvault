const { test } = require('node:test');
const assert = require('node:assert/strict');
const { operations } = require('./operations.js');

test('workflow forms build scoped, non-shell CLI arguments without tokens', () => {
  const args = (id, values, scope = []) => operations.find(operation => operation.id === id).args(values, scope);
  const scope = ['--project', 'demo', '--env', 'production'];
  assert.deepEqual(args('import', { file: 'file with spaces.env', overwrite: true }, scope), ['import', 'file with spaces.env', ...scope, '--overwrite']);
  assert.deepEqual(args('export', { format: 'json', output: '' }, ['--global']), ['export', '--global', '--format', 'json']);
  assert.deepEqual(args('context', { action: 'bind' }, scope), ['use', 'demo/production']);
  assert.throws(() => args('context', { action: 'bind' }, ['--global']), /environment/);
  assert.deepEqual(args('run', { program: 'node', arguments: '-e\nconsole.log("literal ; &")', quiet: false }, scope), ['run', ...scope, '--', 'node', '-e', 'console.log("literal ; &")']);
  const connect = args('connect', { url: 'https://example.com', action: 'import', token: 'private-token', share: 'demo/dev', noSave: true }, ['--global']);
  assert.deepEqual(connect, ['connect', 'https://example.com', '--global', '--share', 'demo/dev', '--no-save', '--yes']);
  assert.ok(!connect.includes('private-token'));
  assert.deepEqual(args('sync', { action: 'pull', url: 'https://example.com', id: 'laptop', noSave: true }), ['sync', 'pull', 'https://example.com', '--id', 'laptop', '--no-save', '--yes']);
  assert.deepEqual(args('docker', { action: 'compose', arguments: 'up\n--build', service: 'api', only: 'TOKEN', mode: 'secret', quiet: false }, scope), ['docker', 'compose', '--only', 'TOKEN', '--service', 'api', '--mode', 'secret', '--', 'up', '--build']);
  assert.deepEqual(args('docker', { action: 'plan', arguments: '' }, scope), ['docker', 'plan', ...scope]);
  assert.deepEqual(args('saved-tokens', { action: 'remove-all' }), ['tokens', 'remove', '--all']);
});
