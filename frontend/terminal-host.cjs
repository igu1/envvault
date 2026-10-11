const pty = require('node-pty');
const { prepareCommand } = require('./runner.cjs');
const { terminateGroup } = require('./terminal.cjs');

let terminal;
let stopped = false;
function send(message, done) {
  if (!process.connected) { done?.(); return; }
  process.send(message, error => { if (error) stop(); done?.(); });
}
function stop() {
  if (stopped) return;
  stopped = true;
  if (!terminal) return process.exit(0);
  terminateGroup(terminal.pid);
  setTimeout(() => { terminateGroup(terminal.pid, true); process.exit(0); }, 1000).unref();
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', async message => {
  try {
    if (message.type === 'start' && !terminal) {
      const { cli, env } = await prepareCommand(message.request);
      if (stopped) return;
      delete env.NO_COLOR;
      env.FORCE_COLOR = '1';
      env.TERM = 'xterm-256color';
      terminal = pty.spawn(process.execPath, [cli, ...message.request.args], { name: 'xterm-256color', cols: 100, rows: 28, cwd: message.request.cwd, env });
      send({ type: 'started', pid: terminal.pid });
      terminal.onData(data => { terminal.pause(); send({ type: 'data', data }); });
      terminal.onExit(({ exitCode }) => send({ type: 'exit', code: exitCode }, () => process.exit(0)));
    } else if (message.type === 'input' && terminal) terminal.write(message.data);
    else if (message.type === 'resize' && terminal) terminal.resize(message.cols, message.rows);
    else if (message.type === 'resume' && terminal) terminal.resume();
    else if (message.type === 'stop') stop();
  } catch {
    send({ type: 'error', message: 'Terminal failed to start or update. Check Node.js and the node-pty installation.' });
    stop();
  }
});
