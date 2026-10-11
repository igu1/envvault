const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

test('native clipboard IPC validates callers, preserves new clipboard text, and clears on lock', async () => {
  const handlers = new Map();
  const timers = new Map();
  let text = '';
  let window;
  let timerId = 0;
  let bulkOutput = 'A=first\nB="two words"\n';
  const terminals = { size: 0, hasUi: false, stopAll: async () => {} };
  const electron = {
    clipboard: { readText: () => text, writeText: value => { text = value; }, clear: () => { text = ''; } },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: () => {} },
    app: { whenReady: () => ({ then: callback => callback() }), on: () => {}, quit: () => {}, getPath: () => path.join(__dirname, '.test-userdata'), isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: buffer => buffer.toString() },
    dialog: {},
    BrowserWindow: class {
      constructor() {
        window = this;
        this.webContents = { setWindowOpenHandler: () => {}, on: () => {}, session: { setPermissionRequestHandler: () => {} } };
      }
      on() {}
      loadFile() {}
    },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    __dirname,
    process: { platform: 'linux' },
    require: name => name === 'electron' ? electron : name === './runner.cjs' ? { runCommand: async request => ({ code: 0, stdout: request.args[0] === 'get' ? 'test-secret\n' : request.args[0] === 'export' ? bulkOutput : '', stderr: '' }) } : name === './terminal.cjs' ? { createTerminals: () => terminals } : require(name),
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const event = { sender: window.webContents, senderFrame: { url: pathToFileURL(path.join(__dirname, 'index.html')).href } };
  const request = { args: ['get', 'TOKEN', '--raw'] };
  const copy = handlers.get('ev:copy');
  await assert.rejects(copy({ ...event, sender: {} }, request, 30), /Untrusted/);
  await assert.rejects(copy(event, request, -1), /Invalid/);
  await copy(event, request, 30);
  assert.equal(text, 'test-secret');
  text = 'new user clipboard';
  timers.get(timerId)();
  assert.equal(text, 'new user clipboard');
  await copy(event, request, 30);
  timers.get(timerId)();
  assert.equal(text, '');
  const bulk = { args: ['export', '--format', 'env', '--global'] };
  const message = await copy(event, bulk, 30);
  assert.equal(text, bulkOutput);
  assert.ok(!message.includes('two words'));
  await assert.rejects(copy(event, { args: ['export', '--format', 'json'] }, 30), /Invalid/);
  await assert.rejects(copy(event, { args: [...bulk.args, '--output=unexpected.env'] }, 30), /Invalid/);
  bulkOutput = '';
  text = 'keep my clipboard';
  await copy(event, bulk, 30);
  assert.equal(text, 'keep my clipboard');
  await copy(event, request, 0);
  await handlers.get('ev:run')(event, { args: ['lock'] });
  assert.equal(text, '');
});
