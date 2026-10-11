const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runCommand } = require('./runner.cjs');
const { createTerminals } = require('./terminal.cjs');

test('real terminals support TTY input, exclusive UI, and process-tree shutdown', { timeout: 25000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'envvault-pty-test-'));
  const previous = process.env.ENVVAULT_HOME;
  process.env.ENVVAULT_HOME = path.join(root, '.envvault');
  const request = { cwd: root, password: 'test-password-123', input: '' };
  const events = new EventEmitter();
  const messages = [];
  const output = new Map();
  const manager = createTerminals(message => {
    messages.push(message);
    if (message.type === 'data') { output.set(message.id, (output.get(message.id) || '') + message.data); manager.resume(message.id); }
    events.emit('message', message);
  });
  function wait(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off('message', check); reject(new Error(`Terminal wait timed out: ${JSON.stringify(messages)}`)); }, 8000);
      function check() { if (predicate()) { clearTimeout(timer); events.off('message', check); resolve(); } }
      events.on('message', check);
    });
  }
  try {
    assert.equal((await runCommand({ ...request, args: ['init'] })).code, 0);
    assert.equal((await runCommand({ ...request, args: ['project', 'add', 'demo', '--env', 'dev'] })).code, 0);
    const id = randomUUID();
    const base = ['run', '--project', 'demo', '--env', 'dev', '--', process.execPath, '-e'];
    await manager.start(id, { ...request, args: [...base, 'process.stdin.setRawMode(true);process.stdout.write("TTY:"+process.stdin.isTTY);process.stdin.on("data",data=>{process.stdout.write("received:"+data);process.exit(0)})'] });
    await wait(() => output.get(id)?.includes('TTY:true'));
    manager.resize(id, 90, 25);
    manager.input(id, 'hello');
    await wait(() => messages.some(message => message.id === id && message.type === 'closed'));
    assert.match(output.get(id), /received:hello/);
    const ui = randomUUID();
    await manager.start(ui, { ...request, args: ['ui'] });
    await wait(() => messages.some(message => message.id === ui && message.type === 'started'));
    await wait(() => output.get(ui)?.includes('Browse secrets'));
    await assert.rejects(manager.start(randomUUID(), { ...request, args: ['--help'] }), /exclusive/);
    manager.input(ui, '\x03');
    await wait(() => messages.some(message => message.id === ui && message.type === 'closed'));
    assert.equal((await runCommand({ ...request, args: ['server', 'enable'] })).code, 0);
    const server = randomUUID();
    await manager.start(server, { ...request, args: ['serve', '--host', '127.0.0.1', '--port', '0'] });
    await wait(() => output.get(server)?.includes('Listening on'));
    await manager.stop(server);
    const tree = randomUUID();
    const pidFile = path.join(root, 'child.pid');
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));console.log('CHILD_READY');setInterval(()=>{},1000);`;
    await manager.start(tree, { ...request, args: [...base, script] });
    await wait(() => output.get(tree)?.includes('CHILD_READY'));
    const childPid = Number(await readFile(pidFile, 'utf8'));
    await manager.stop(tree);
    if (process.platform !== 'win32') {
      // A killed process can briefly remain as a zombie until its parent reaps it.
      try { assert.match(await readFile(`/proc/${childPid}/stat`, 'utf8'), /\) Z /); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.equal(manager.size, 0);
  } finally {
    await manager.stopAll();
    if (previous === undefined) delete process.env.ENVVAULT_HOME;
    else process.env.ENVVAULT_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
