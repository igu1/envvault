const { execFile } = require('node:child_process');
const { access, stat } = require('node:fs/promises');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../dist/cli.js');
const COMMANDS = new Set([
  '--help', '--version', 'init', 'unlock', 'lock', 'project', 'use', 'unuse',
  'set', 'get', 'list', 'delete', 'import', 'export', 'run', 'copy', 'doctor',
  'docker', 'server', 'share', 'serve', 'connect', 'sync', 'tokens', 'ui',
]);

async function prepareCommand(request) {
  if (!request || !Array.isArray(request.args) || request.args.length > 256 ||
      request.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65536) ||
      !COMMANDS.has(request.args[0])) {
    throw new Error('Choose a supported EnvVault command.');
  }
  if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd) ||
      !(await stat(request.cwd)).isDirectory()) {
    throw new Error('Select an existing absolute working directory.');
  }
  for (const field of ['password', 'input', 'shareToken']) {
    if (field === 'shareToken' && request[field] === undefined) continue;
    if (typeof request[field] !== 'string' || request[field].length > 1048576 || request[field].includes('\0')) {
      throw new Error(`Invalid ${field}.`);
    }
  }
  try {
    await access(CLI);
  } catch {
    throw new Error('CLI build missing. Run npm run build in the repository root.');
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' };
  delete env.ENVVAULT_MASTER_PASSWORD;
  delete env.ENVVAULT_MASTER_PASSWORD_FILE;
  delete env.ENVVAULT_SHARE_TOKEN;
  if (request.password) env.ENVVAULT_MASTER_PASSWORD = request.password;
  if (request.shareToken) env.ENVVAULT_SHARE_TOKEN = request.shareToken;
  return { cli: CLI, env };
}

async function runCommand(request, executable = process.execPath) {
  const { cli, env } = await prepareCommand(request);
  if (['ui', 'serve'].includes(request.args[0])) throw new Error('Use the embedded terminal for this command.');

  return new Promise(resolve => {
    const child = execFile(executable, [cli, ...request.args], {
      cwd: request.cwd, env, shell: false, timeout: 60000, maxBuffer: 1048576,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr: stderr + (error?.killed ? '\nCommand stopped: time or output limit exceeded.' : ''),
      });
    });
    child.stdin.on('error', () => {}); // A command may exit before reading input.
    child.stdin.end(request.input);
  });
}

module.exports = { runCommand, prepareCommand };
