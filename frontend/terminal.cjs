const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const { prepareCommand } = require('./runner.cjs');

function terminateGroup(pid, force = false) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
  } else {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function createTerminals(emit) {
  const sessions = new Map();
  async function start(id, request) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || sessions.has(id)) throw new Error('Invalid terminal session.');
    // ponytail: four concurrent terminals; raise the limit if more workers are needed.
    await prepareCommand(request);
    if (sessions.has(id)) throw new Error('Terminal session already exists.');
    if (sessions.size >= 4) throw new Error('Four terminals are already running. Stop one first.');
    if ([...sessions.values()].some(session => session.command === 'ui') || (request.args[0] === 'ui' && sessions.size)) throw new Error('The original terminal UI requires an exclusive session. Stop other terminals first.');
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ENVVAULT_MASTER_PASSWORD', 'ENVVAULT_MASTER_PASSWORD_FILE', 'ENVVAULT_SHARE_TOKEN']) delete env[key];
    // System Node owns the native PTY addon, so Electron needs no native ABI rebuild.
    const host = fork(path.join(__dirname, 'terminal-host.cjs'), [], { execPath: 'node', env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const session = { host, pid: null, stopped: false, command: request.args[0] };
    sessions.set(id, session);
    host.on('message', message => {
      if (message.type === 'started') session.pid = message.pid;
      emit({ ...message, id });
    });
    host.on('error', () => emit({ id, type: 'error', message: 'Could not start the terminal. Install Node.js 20+ and run npm install in frontend.' }));
    host.on('exit', () => {
      sessions.delete(id);
      terminateGroup(session.pid, true);
      if (session.pid === null) emit({ id, type: 'error', message: 'PTY helper could not start. Ensure Node.js 20+ is on PATH and run npm install in frontend.' });
      emit({ id, type: 'closed' });
    });
    host.send({ type: 'start', request });
    return id;
  }
  function send(id, message) {
    const session = sessions.get(id);
    if (!session || !session.host.connected) return;
    if (message.type === 'input' && (typeof message.data !== 'string' || message.data.length > 65536)) throw new Error('Invalid terminal input.');
    if (message.type === 'resize' && (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 2 || message.cols > 500 || message.rows < 2 || message.rows > 200)) throw new Error('Invalid terminal size.');
    session.host.send(message);
  }
  function stop(id) {
    const session = sessions.get(id);
    if (!session) return Promise.resolve();
    if (session.stopped) return session.closed;
    session.stopped = true;
    session.closed = new Promise(resolve => session.host.once('exit', resolve));
    send(id, { type: 'stop' });
    setTimeout(() => {
      if (!sessions.has(id)) return;
      terminateGroup(session.pid, true);
      session.host.kill();
    }, 1500).unref();
    return session.closed;
  }
  return { start, input: (id, data) => send(id, { type: 'input', data }), resize: (id, cols, rows) => send(id, { type: 'resize', cols, rows }), resume: id => send(id, { type: 'resume' }), stop, stopAll: () => Promise.all([...sessions.keys()].map(stop)), get size() { return sessions.size; }, get hasUi() { return [...sessions.values()].some(session => session.command === 'ui'); } };
}

module.exports = { createTerminals, terminateGroup };
