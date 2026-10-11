const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runCommand, setCliPath } = require('./runner.cjs');
const { createTerminals } = require('./terminal.cjs');
const { createServerStore, resolveTargetRequest } = require('./servers.cjs');

// A packaged app ships the bundled CLI next to the app resources.
if (app.isPackaged) setCliPath(path.join(process.resourcesPath, 'cli', 'cli.js'));

// Server tokens are encrypted by the OS keychain (safeStorage) before they are saved.
const servers = createServerStore({
  file: path.join(app.getPath('userData'), 'servers.json'),
  crypto: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: text => safeStorage.encryptString(text),
    decrypt: buffer => safeStorage.decryptString(buffer),
  },
});

const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
let window;
let busy = false;
let clipboardTimer;
let copiedValue;
function clearCopiedValue() {
  clearTimeout(clipboardTimer);
  if (copiedValue !== undefined && clipboard.readText() === copiedValue) clipboard.clear();
  copiedValue = undefined;
}
const terminals = createTerminals(message => {
  if (window && !window.isDestroyed()) window.webContents.send('ev:terminal-event', message);
});

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page) {
    throw new Error('Untrusted request.');
  }
}

ipcMain.handle('ev:directory', async event => {
  assertSender(event);
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('ev:servers', event => {
  assertSender(event);
  return servers.list();
});
ipcMain.handle('ev:server-save', (event, input) => {
  assertSender(event);
  return servers.save(input);
});
ipcMain.handle('ev:server-remove', (event, id) => {
  assertSender(event);
  if (typeof id !== 'string' || id.length > 64) throw new Error('Invalid server.');
  return servers.remove(id);
});

ipcMain.handle('ev:defaults', event => {
  assertSender(event);
  return { cwd: app.getPath('home') };
});

ipcMain.handle('ev:file', async (event, mode, options) => {
  assertSender(event);
  if (mode === 'save') {
    const format = options?.format ?? 'env';
    if (!['env', 'json', 'csv', 'shell'].includes(format)) throw new Error('Invalid export format.');
    const result = await dialog.showSaveDialog(window, { title: 'Export plaintext secrets', defaultPath: `secrets.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }, { name: 'All files', extensions: ['*'] }] });
    return result.canceled ? null : result.filePath;
  }
  if (mode !== 'open') throw new Error('Invalid file dialog.');
  const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: 'Import environment file' });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('ev:terminal-start', async (event, id, request) => {
  assertSender(event);
  if (request?.target) throw new Error('Live terminals use the local vault. Choose Local vault as the target.');
  if (busy) throw new Error('Wait for the current command to finish.');
  busy = true;
  try { return await terminals.start(id, request); } finally { busy = false; }
});
ipcMain.handle('ev:terminal-stop', (event, id) => { assertSender(event); return terminals.stop(id); });
ipcMain.handle('ev:terminal-stop-all', event => { assertSender(event); return terminals.stopAll(); });
ipcMain.on('ev:terminal-resume', (event, id) => { try { assertSender(event); terminals.resume(id); } catch {} });
for (const [channel, method] of [['ev:terminal-input', 'input'], ['ev:terminal-resize', 'resize']]) {
  ipcMain.on(channel, (event, ...args) => {
    try { assertSender(event); terminals[method](...args); } catch { /* Reject untrusted or malformed terminal messages. */ }
  });
}

ipcMain.handle('ev:run', async (event, request) => {
  assertSender(event);
  if (busy) throw new Error('A command is already running.');
  if (terminals.hasUi && request?.args?.[0] !== 'lock') throw new Error('Stop the original terminal UI before using other vault controls; it holds a vault snapshot in memory.');
  busy = true;
  try {
    if (request?.args?.[0] === 'lock') { await terminals.stopAll(); clearCopiedValue(); }
    return await runCommand(resolveTargetRequest(request, servers));
  } finally {
    busy = false;
  }
});

ipcMain.handle('ev:copy', async (event, request, seconds = 30) => {
  assertSender(event);
  const args = request?.args;
  const single = Array.isArray(args) && args[0] === 'get' && args.includes('--raw');
  const bulk = Array.isArray(args) && args[0] === 'export' && args[args.indexOf('--format') + 1] === 'env' && !args.some(arg => typeof arg === 'string' && (arg === '--output' || arg.startsWith('--output=')));
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400 || (!single && !bulk)) throw new Error('Invalid clipboard request.');
  if (busy) throw new Error('A command is already running.');
  if (terminals.hasUi) throw new Error('Stop the original terminal UI before using other vault controls.');
  busy = true;
  try {
    const result = await runCommand(resolveTargetRequest(request, servers));
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not read the secret.');
    if (bulk && result.stdout === '') return 'No secrets to copy. Clipboard unchanged.';
    clearTimeout(clipboardTimer);
    copiedValue = bulk ? result.stdout : result.stdout.replace(/\r?\n$/, '');
    clipboard.writeText(copiedValue);
    if (seconds > 0) clipboardTimer = setTimeout(clearCopiedValue, seconds * 1000);
    return `${bulk ? 'All secrets copied as .env text.' : 'Secret copied.'} ${seconds ? `Clipboard clears after ${seconds} seconds if unchanged.` : 'Automatic clearing is disabled.'}`;
  } finally { busy = false; }
});

function createWindow() {
  window = new BrowserWindow({
    title: 'EnvVault', width: 1440, height: 1000, minWidth: 900, minHeight: 680,
    backgroundColor: '#0c1014',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', event => {
    if (terminals.size && dialog.showMessageBoxSync(window, { type: 'warning', buttons: ['Cancel', 'Stop terminals and close'], defaultId: 0, cancelId: 0, message: 'Running commands and sharing servers will be stopped.' }) === 0) event.preventDefault();
    else { terminals.stopAll(); clearCopiedValue(); }
  });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) terminals.stopAll(); });
  window.webContents.on('destroyed', () => terminals.stopAll());
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
