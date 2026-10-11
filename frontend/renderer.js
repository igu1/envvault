const $ = id => document.getElementById(id);
const commands = ['list', 'project', 'init', 'unlock', 'lock', 'use', 'unuse', 'set', 'get', 'delete', 'import', 'export', 'run', 'copy', 'doctor', 'docker', 'server', 'share', 'serve', 'connect', 'sync', 'tokens', 'ui', '--help', '--version'];
for (const command of commands) $('command').add(new Option(command, command));
let snapshot = null;
let selected = { kind: 'global' };
let secrets = [];
let busy = false;
let activeView = 'overview';
// Saved sharing servers (names and URLs only) and the chosen target: null = local vault.
let servers = [];
let currentTarget = null;
const revealed = new Map();
const terminalSessions = new Map();
const featureGroups = {
  tools: ['vault tools', 'Import/export, diagnostics, directory context, and clipboard controls.'],
  execution: ['run / docker', 'Inject secrets into programs, containers, Compose, and BuildKit.'],
  sharing: ['sharing server', 'Configure the server, choose shared keys, issue tokens, and start serving.'],
  remote: ['connect / backups', 'Pull selected shares, sync encrypted backups, and manage saved credentials.'],
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action, data = {}, className = '') {
  const element = node('button', text, className);
  element.type = 'button';
  element.dataset.action = action;
  Object.assign(element.dataset, data);
  return element;
}
function required(id) {
  const value = $(id).value.trim();
  if (!value) throw new Error(`Enter ${id === 'cwd' ? 'a working directory in Vault access' : id}.`);
  return value;
}
function scopeArgs(scope = selected) {
  if (scope.kind === 'global') return ['--global'];
  return ['--project', scope.project, ...(scope.kind === 'shared' ? ['--shared'] : ['--env', scope.environment])];
}
function scopeLabel(scope = selected) {
  if (scope.kind === 'global') return 'Global secrets';
  return `${scope.project} / ${scope.kind === 'shared' ? 'Shared' : scope.environment}`;
}
function view(name) {
  activeView = name;
  $('servers-view').hidden = name !== 'servers';
  if (name === 'servers') renderServers();
  $('overview-view').hidden = name !== 'overview';
  $('commands-view').hidden = name !== 'commands';
  $('features-view').hidden = !featureGroups[name];
  $('terminal-view').hidden = name !== 'terminal';
  $('breadcrumb').textContent = `~/${name}`;
  if (featureGroups[name]) renderFeatures(name);
  if (name === 'terminal') requestAnimationFrame(fitTerminal);
  document.querySelectorAll('[data-view]').forEach(element => element.classList.toggle('active', element.dataset.view === name));
}
function populateScopes() {
  const previous = $('tool-scope').value;
  $('tool-scope').replaceChildren(new Option('Current directory context', 'context'), new Option('Global', JSON.stringify({ kind: 'global' })));
  for (const project of snapshot?.projects || []) {
    $('tool-scope').add(new Option(`${project.name} / shared`, JSON.stringify({ kind: 'shared', project: project.name })));
    for (const environment of project.environments) $('tool-scope').add(new Option(`${project.name} / ${environment.name}`, JSON.stringify({ kind: 'environment', project: project.name, environment: environment.name })));
  }
  if ([...$('tool-scope').options].some(option => option.value === previous)) $('tool-scope').value = previous;
}
function remoteBlocked(operation) {
  return Boolean(currentTarget) && !operation.remote;
}
function renderFeatures(group) {
  document.querySelector('.feature-context').hidden = group === 'sharing';
  $('features-title').textContent = `$ ${featureGroups[group][0]}`;
  $('features-description').textContent = featureGroups[group][1];
  $('feature-forms').replaceChildren();
  for (const operation of window.evOperations.operations.filter(operation => operation.group === group)) {
    const form = node('form', undefined, 'feature-form');
    form.id = `operation-${operation.id}`;
    form.append(node('h2', operation.title), node('p', operation.description));
    const fields = node('div', undefined, 'feature-fields');
    for (const field of operation.fields) {
      const label = node('label', field.type === 'checkbox' ? undefined : field.label, field.type === 'checkbox' ? 'check-field' : '');
      let input;
      if (field.type === 'select') {
        input = node('select');
        for (const choice of field.options) input.add(new Option(choice, choice));
      } else if (field.type === 'textarea') { input = node('textarea'); input.rows = 3; }
      else { input = node('input'); input.type = ['checkbox', 'password', 'number', 'url'].includes(field.type) ? field.type : 'text'; }
      input.name = field.id;
      input.required = field.required;
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.type === 'number') input.min = '0';
      if (field.type === 'checkbox') input.checked = Boolean(field.default);
      if (['open', 'save'].includes(field.type)) {
        const file = node('div', undefined, 'directory-field');
        file.append(input, button('Browse', 'operation-file', { mode: field.type, operation: operation.id, field: field.id }, 'button small'));
        label.append(file);
      } else label.append(input);
      if (field.type === 'checkbox') label.append(document.createTextNode(field.label));
      fields.append(label);
    }
    const controls = node('div', undefined, 'section-actions');
    const submit = node('button', operation.terminal ? 'Launch terminal' : 'Execute', 'button primary');
    submit.type = 'submit';
    const blocked = remoteBlocked(operation);
    submit.disabled = blocked;
    if (blocked) submit.title = 'Runs against the local vault. Choose Local vault as the target.';
    controls.append(submit);
    if (!blocked && !operation.terminal && operation.id !== 'copy') controls.append(button('Run interactively', 'operation-terminal', { operation: operation.id }, 'button'));
    form.append(fields, controls, node('p', operation.scoped ? '// uses target scope above' : '// no target scope required', 'muted'));
    form.addEventListener('submit', event => { event.preventDefault(); perform('operation', { operation: operation.id }); });
    $('feature-forms').append(form);
  }
}
function request(args, input = '', shareToken = '') {
  return { args, cwd: required('cwd'), password: $('password').value, input, shareToken, target: currentTarget };
}
function targetName() {
  return currentTarget ? servers.find(server => server.id === currentTarget)?.name ?? 'server' : 'local vault';
}
function renderTargets() {
  const select = $('target-select');
  select.replaceChildren(new Option('Local vault', ''));
  for (const server of servers) select.add(new Option(`${server.name} · server`, server.id));
  select.value = currentTarget ?? '';
  $('target-note').textContent = currentTarget ? servers.find(server => server.id === currentTarget)?.url ?? 'server' : 'encrypted · on-device';
}
function renderServers() {
  $('server-list').replaceChildren(node('p', `Active target: ${targetName()}`, 'muted'));
  if (!servers.length) $('server-list').append(node('p', 'No servers saved yet.', 'muted'));
  for (const server of servers) {
    const row = node('div', undefined, 'server-row');
    const info = node('div');
    info.append(node('strong', server.name), node('span', server.url, 'muted'));
    const active = server.id === currentTarget;
    const use = button(active ? 'In use' : 'Use', 'target', { id: server.id }, 'button small');
    use.disabled = active;
    row.append(info, use, button('Remove', 'server-remove', { id: server.id }, 'button small danger'));
    $('server-list').append(row);
  }
}
async function loadServers() {
  servers = await window.envvault.servers();
  if (currentTarget && !servers.some(server => server.id === currentTarget)) currentTarget = null;
  renderTargets();
  if (!$('servers-view').hidden) renderServers();
}
async function setTarget(id) {
  const next = id || null;
  if (next === currentTarget) return;
  if ([...terminalSessions.values()].some(session => session.running) && !confirm('Switching the target stops running embedded commands and servers. Continue?')) {
    renderTargets();
    return;
  }
  await window.envvault.stopTerminals();
  clearSensitive();
  disposeTerminals();
  currentTarget = next;
  selected = { kind: 'global' };
  disconnect();
  renderTargets();
  view(activeView);
  if (currentTarget) {
    await refresh();
    $('status').textContent = `Connected to ${targetName()}`;
  } else {
    await perform('bootstrap');
  }
}
async function copySecret(key, scope = selected, seconds = 30) {
  if (seconds === 0 && !confirm('Keep this secret on the clipboard without automatic clearing?')) return;
  $('output').textContent = await window.envvault.copy(request(['get', key, '--raw', ...scopeArgs(scope)]), seconds);
  $('console').open = true;
}
async function bulkAction(action, data) {
  if (!snapshot) throw new Error('Connect your vault first.');
  const scope = data.scope ? JSON.parse(data.scope) : selected;
  const sameScope = JSON.stringify(scope) === JSON.stringify(selected);
  if (action === 'bulk-reveal' && sameScope && secrets.length && secrets.every(secret => revealed.has(secret.name))) {
    revealed.clear(); renderSecrets(); return;
  }
  if (action === 'bulk-copy') {
    if (!confirm(`Copy all secrets from ${scopeLabel(scope)} as plaintext .env text? The clipboard clears after 30 seconds if unchanged.`)) return;
    $('output').textContent = await window.envvault.copy(request(['export', '--format', 'env', ...scopeArgs(scope)]), 30);
    $('console').open = true;
    return;
  }
  if (action === 'bulk-export') {
    if (!['env', 'csv', 'json'].includes(data.format)) throw new Error('Choose .env, CSV, or JSON.');
    if (!confirm(`Export all secrets from ${scopeLabel(scope)} to a plaintext ${data.format === 'env' ? '.env' : data.format.toUpperCase()} file?${data.format === 'csv' ? ' Import CSV columns as text to prevent spreadsheet formula evaluation.' : ''}`)) return;
    const file = await window.envvault.chooseFile('save', { format: data.format });
    if (file) await run(['export', '--format', data.format, '--output', file, ...scopeArgs(scope)]);
    return;
  }
  if (!confirm(`Reveal every secret in ${scopeLabel(scope)} in plaintext, including keys hidden by the search filter?`)) return;
  selected = { ...scope };
  if (!sameScope) $('secret-search').value = '';
  view('overview'); renderOverview(); await loadSecrets();
  const values = JSON.parse(await run(['export', '--format', 'json', ...scopeArgs(scope)], '', false) || '{}');
  for (const [name, value] of Object.entries(values)) revealed.set(name, value);
  renderSecrets();
  $('secret-panel').scrollIntoView({ block: 'start' });
}
async function runOperation(id, interactive = false) {
  const operation = window.evOperations.operations.find(operation => operation.id === id);
  const form = $(`operation-${id}`);
  if (!operation || !form.reportValidity()) return;
  const values = Object.fromEntries(operation.fields.map(field => {
    const input = form.elements.namedItem(field.id);
    return [field.id, field.type === 'checkbox' ? input.checked : field.type === 'textarea' ? input.value : input.value.trim()];
  }));
  const scope = $('tool-scope').value === 'context' ? null : JSON.parse($('tool-scope').value);
  if (operation.environment && scope && scope.kind !== 'environment') throw new Error('Select an environment or the current directory context.');
  if (id === 'connect' && values.action === 'import' && !scope) throw new Error('Choose an explicit global, shared, or environment target for remote imports.');
  if (remoteBlocked(operation)) throw new Error(`${operation.title.replace(/^\$ /, '')} runs against the local vault. Choose Local vault as the target first.`);
  const args = operation.args(values, operation.scoped && scope ? scopeArgs(scope) : []);
  if (operation.confirm && !confirm(operation.confirm)) return;
  if (id === 'copy') {
    const selectedScope = scope;
    const copyArgs = ['get', values.key, '--raw', ...(selectedScope ? scopeArgs(selectedScope) : [])];
    const seconds = Number(values.seconds || '30');
    if (seconds === 0 && !confirm('Keep this secret on the clipboard without automatic clearing?')) return;
    $('output').textContent = await window.envvault.copy(request(copyArgs), seconds);
    $('console').open = true;
    return;
  }
  if (id === 'sync' && values.action === 'pull') await window.envvault.stopTerminals();
  if (operation.bindsDirectory && values.action !== 'plan' && scope) await run(['use', `${scope.project}/${scope.environment}`]);
  const credentials = values.token || '';
  for (const field of operation.fields.filter(field => field.type === 'password')) form.elements.namedItem(field.id).value = '';
  if (operation.terminal || interactive) { await launchTerminal(args, credentials); return; }
  await run(args, '', true, credentials);
  if (id === 'sync' && values.action === 'pull') { $('password').value = ''; disconnect(); return; }
  if (id === 'server' && values.action === 'disable') await Promise.all([...terminalSessions.values()].filter(session => session.command === 'serve' && session.running).map(session => window.envvault.stopTerminal(session.id)));
  if (operation.refresh && snapshot) await refresh();
}

function fitTerminal() {
  const session = terminalSessions.get($('terminal-session').value);
  if (!session || $('terminal-view').hidden) return;
  session.fit.fit();
  if (session.running) window.envvault.resizeTerminal(session.id, session.terminal.cols, session.terminal.rows);
}
function selectTerminal() {
  const id = $('terminal-session').value;
  for (const [key, session] of terminalSessions) session.container.hidden = key !== id;
  $('terminal-empty').hidden = terminalSessions.size > 0;
  requestAnimationFrame(fitTerminal);
}
async function launchTerminal(args, shareToken = '') {
  if (terminalSessions.size >= 4) throw new Error('Four terminal panes are open. Close a session before starting another command.');
  const id = crypto.randomUUID();
  const container = node('div', undefined, 'terminal-instance');
  container.hidden = true;
  $('terminal-hosts').append(container);
  const terminal = new Terminal({ fontFamily: 'Consolas, "Liberation Mono", monospace', fontSize: 13, scrollback: 1000, cursorBlink: false, theme: { background: '#080e11', foreground: '#cad3dd', cursor: '#80e5a7', selectionBackground: '#284537' } });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  const option = new Option(`envvault ${args[0]} · starting`, id);
  if (!terminalSessions.size) $('terminal-session').replaceChildren();
  $('terminal-session').add(option);
  const session = { id, terminal, fit, container, option, running: true, command: args[0] };
  terminalSessions.set(id, session);
  terminal.onData(data => { if (session.running) window.envvault.writeTerminal(id, data); });
  $('terminal-session').value = id;
  view('terminal');
  selectTerminal();
  try { await window.envvault.startTerminal(id, request(args, '', shareToken)); }
  catch (error) { session.running = false; option.text = `envvault ${args[0]} · failed`; terminal.writeln(`\r\n${error.message}`); throw error; }
  finally { updateTerminalCount(); }
}
function updateTerminalCount() { $('terminal-running').textContent = [...terminalSessions.values()].filter(session => session.running).length; }
function disposeTerminals() {
  for (const session of terminalSessions.values()) { session.terminal.dispose(); session.container.remove(); }
  terminalSessions.clear();
  $('terminal-session').replaceChildren(new Option('No sessions', ''));
  selectTerminal(); updateTerminalCount();
}
window.envvault.onTerminal(message => {
  const session = terminalSessions.get(message.id);
  if (!session) return;
  if (message.type === 'data') session.terminal.write(message.data, () => window.envvault.resumeTerminal(message.id));
  if (message.type === 'started') { session.option.text = `envvault ${session.command} · running`; fitTerminal(); }
  if (message.type === 'error') { session.terminal.writeln(`\r\n${message.message}`); session.running = false; session.option.text = `envvault ${session.command} · failed`; }
  if (message.type === 'exit') { session.terminal.writeln(`\r\n[process exited: ${message.code}]`); session.running = false; session.option.text = `envvault ${session.command} · exit ${message.code}`; }
  if (message.type === 'closed') { session.running = false; if (!/exit|failed/.test(session.option.text)) session.option.text = `envvault ${session.command} · stopped`; }
  updateTerminalCount();
});
$('terminal-session').addEventListener('change', selectTerminal);
new ResizeObserver(fitTerminal).observe($('terminal-hosts'));
function clearSensitive() {
  for (const id of ['password', 'value', 'input', 'args']) $(id).value = '';
  $('output').textContent = '';
  revealed.clear();
  document.querySelectorAll('.feature-form input[type="password"]').forEach(input => { input.value = ''; });
  for (const session of terminalSessions.values()) { session.terminal.reset(); session.terminal.clearSelection(); }
  renderSecrets();
}
function disconnect() {
  snapshot = null;
  secrets = [];
  revealed.clear();
  $('secret-panel').hidden = true;
  $('connection-state').textContent = 'Not connected';
  $('connection-state').classList.remove('connected');
  $('hero-connect').textContent = 'Connect vault →';
  $('last-refreshed').textContent = 'No vault data loaded';
  renderOverview();
}
async function run(args, input = '', showOutput = true, shareToken = '') {
  const result = await window.envvault.run(request(args, input, shareToken));
  if (showOutput || result.code !== 0) {
    $('output').textContent = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(No output)';
    $('console').open = true;
  }
  if (result.code !== 0) {
    const error = new Error(result.stderr.trim() || `Command failed with exit ${result.code}.`);
    error.commandOutput = true;
    throw error;
  }
  return result.stdout;
}
async function refresh() {
  try {
    snapshot = JSON.parse(await run(['project', 'list', '--json'], '', false));
  } catch (error) {
    disconnect();
    throw error;
  }
  if (selected.kind !== 'global') {
    const project = snapshot.projects.find(project => project.name === selected.project);
    if (!project || (selected.kind === 'environment' && !project.environments.some(env => env.name === selected.environment))) selected = { kind: 'global' };
  }
  renderOverview();
  await loadSecrets();
  $('connection-state').textContent = currentTarget ? `Server: ${targetName()}` : 'Vault connected';
  $('connection-state').classList.add('connected');
  $('hero-connect').textContent = 'Manage access →';
  $('last-refreshed').textContent = `Refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
function renderOverview() {
  const projects = snapshot?.projects || [];
  const environmentCount = projects.reduce((count, project) => count + project.environments.length, 0);
  const secretCount = projects.reduce((count, project) => count + project.sharedSecretCount + project.environments.reduce((sum, env) => sum + env.secretCount, 0), snapshot?.globalSecretCount || 0);
  $('terminal-summary').textContent = snapshot ? `→ ${projects.length} projects / ${environmentCount} environments / ${secretCount} stored secrets` : '# awaiting vault connection';
  $('terminal-cwd').textContent = $('cwd').value || 'not selected';
  populateScopes();
  for (const [id, value] of Object.entries({ 'stat-projects': projects.length, 'stat-environments': environmentCount, 'stat-secrets': secretCount, 'stat-globals': snapshot?.globalSecretCount || 0, 'project-count': projects.length, 'nav-count': projects.length })) $(id).textContent = snapshot ? value : '—';
  $('project-nav').replaceChildren();
  if (!snapshot) $('project-nav').append(node('p', 'Connect your vault to see projects.', 'sidebar-hint'));
  projects.forEach(project => {
    const item = button('', 'select', { project: project.name, kind: 'shared' }, 'nav-item');
    item.append(node('span', '', 'project-nav-dot'), node('span', project.name, 'project-nav-name'), node('span', String(project.environments.length), 'nav-count'));
    item.classList.toggle('active', selected.project === project.name);
    $('project-nav').append(item);
  });
  $('project-grid').replaceChildren();
  const query = $('project-search').value.toLowerCase().trim();
  const filtered = projects.filter(project => project.name.toLowerCase().includes(query) || project.environments.some(env => env.name.toLowerCase().includes(query)));
  filtered.forEach(project => {
    const card = $('project-template').content.firstElementChild.cloneNode(true);
    card.classList.toggle('selected', selected.project === project.name);
    card.querySelector('h3').textContent = project.name;
    const count = project.sharedSecretCount + project.environments.reduce((sum, env) => sum + env.secretCount, 0);
    card.querySelector('.project-meta').textContent = `${count} stored secrets · ${project.environments.length} environments`;
    card.querySelector('.environment-total').textContent = project.environments.length;
    const bulkScope = card.querySelector('.card-bulk-scope');
    bulkScope.setAttribute('aria-label', `Bulk action scope for ${project.name}`);
    bulkScope.add(new Option('Project shared', JSON.stringify({ kind: 'shared', project: project.name })));
    for (const env of project.environments) bulkScope.add(new Option(env.name, JSON.stringify({ kind: 'environment', project: project.name, environment: env.name })));
    const defaultScope = selected.project === project.name ? selected : project.environments.length ? { kind: 'environment', project: project.name, environment: project.environments[0].name } : { kind: 'shared', project: project.name };
    bulkScope.value = JSON.stringify(defaultScope);
    bulkScope.addEventListener('change', renderSecrets);
    const list = card.querySelector('.environment-list');
    if (!project.environments.length) list.append(node('p', 'No environments yet.', 'muted'));
    project.environments.forEach(env => {
      const item = button('', 'select', { project: project.name, environment: env.name, kind: 'environment' }, 'environment-button');
      if (/prod/i.test(env.name)) item.classList.add('production');
      else if (/stag/i.test(env.name)) item.classList.add('staging');
      item.classList.toggle('active', selected.project === project.name && selected.environment === env.name);
      item.append(node('span'), node('span', env.name, 'environment-name'), node('span', `${env.secretCount} local keys`, 'environment-count'));
      list.append(item);
    });
    const shared = card.querySelector('.shared-button');
    shared.textContent = `${project.sharedSecretCount} shared secrets ↗`;
    shared.dataset.action = 'select';
    Object.assign(shared.dataset, { project: project.name, kind: 'shared' });
    for (const [selector, action] of [['.add-environment', 'new-environment'], ['.remove-project', 'remove-project']]) {
      Object.assign(card.querySelector(selector).dataset, { action, project: project.name });
    }
    $('project-grid').append(card);
  });
  $('projects-empty').hidden = filtered.length > 0;
  if (!filtered.length) {
    $('projects-empty').querySelector('h3').textContent = !snapshot ? 'Vault not connected' : query ? 'No matching projects' : 'No projects found';
    $('projects-empty').querySelector('p').textContent = !snapshot ? 'Connect your vault to explore projects and environments. Starting fresh? Initialize a vault from Vault access.' : query ? 'Try another project or environment name.' : 'Your vault is ready. Create a project and add its first environment.';
    const emptyButton = $('projects-empty').querySelector('button');
    emptyButton.dataset.action = snapshot ? 'new-project' : 'access';
    emptyButton.textContent = snapshot ? 'Create a project' : 'Connect vault';
    emptyButton.hidden = Boolean(query && snapshot);
  }
}
async function loadSecrets() {
  secrets = [];
  revealed.clear();
  renderSecrets();
  const metadata = JSON.parse(await run(['list', '--json', ...scopeArgs()], '', false));
  secrets = metadata.secrets;
  $('secret-panel').hidden = false;
  $('scope-title').textContent = scopeLabel();
  $('scope-description').textContent = selected.kind === 'global' ? '// global keys: shown only when no project is selected' : selected.kind === 'shared' ? '// project keys inherited by its environments' : '// resolved keys: project shared < environment (globals excluded)';
  $('bind-button').hidden = selected.kind !== 'environment';
  $('scope-tabs').replaceChildren();
  // Globals appear only when no project is selected; a project view never shows them.
  const scopes = selected.kind === 'global' ? [{ kind: 'global', title: 'Global' }] : [];
  if (selected.kind !== 'global') {
    const project = snapshot.projects.find(project => project.name === selected.project);
    scopes.push({ kind: 'shared', project: project.name, title: 'Project shared' }, ...project.environments.map(env => ({ kind: 'environment', project: project.name, environment: env.name, title: env.name })));
  }
  scopes.forEach(scope => {
    const tab = button(scope.title, 'select', { kind: scope.kind, project: scope.project || '', environment: scope.environment || '' }, 'scope-tab');
    tab.classList.toggle('active', scope.kind === selected.kind && scope.environment === selected.environment);
    tab.setAttribute('aria-pressed', String(tab.classList.contains('active')));
    $('scope-tabs').append(tab);
  });
  renderSecrets();
}
function renderSecrets() {
  const allRevealed = secrets.length > 0 && secrets.every(secret => revealed.has(secret.name));
  const updateReveal = (element, active) => { element.textContent = active ? 'Hide all' : 'Reveal all'; element.setAttribute('aria-pressed', String(active)); };
  updateReveal($('reveal-all'), allRevealed);
  document.querySelectorAll('.project-card').forEach(card => updateReveal(card.querySelector('[data-action="bulk-reveal"]'), allRevealed && card.querySelector('.card-bulk-scope').value === JSON.stringify(selected)));
  $('secret-rows').replaceChildren();
  const query = $('secret-search').value.toLowerCase().trim();
  const filtered = secrets.filter(secret => secret.name.toLowerCase().includes(query));
  $('secret-count').textContent = `${filtered.length} of ${secrets.length} keys`;
  filtered.forEach(secret => {
    const row = node('tr');
    const name = node('td', secret.name);
    const value = node('td', revealed.has(secret.name) ? revealed.get(secret.name) : '••••••••••••', `secret-value${revealed.has(secret.name) ? ' revealed' : ''}`);
    const origin = node('td');
    origin.append(node('span', secret.origin === 'project' ? 'project shared' : secret.origin, `origin-badge ${secret.origin}`));
    const actions = node('td');
    const buttons = node('div', undefined, 'row-actions');
    for (const [label, action] of [[revealed.has(secret.name) ? 'Hide' : 'Reveal', 'reveal'], ['Copy', 'copy'], ['Edit', 'edit-secret'], ['Delete', 'delete-secret']]) {
      const item = button(label, action, { key: secret.name, origin: secret.origin }, action === 'delete-secret' ? 'delete' : '');
      item.setAttribute('aria-label', `${label} ${secret.name}`);
      buttons.append(item);
    }
    actions.append(buttons);
    row.append(name, value, origin, actions);
    $('secret-rows').append(row);
  });
  $('secrets-empty').hidden = filtered.length > 0;
  $('secrets-empty').textContent = query ? 'No matching secret names.' : 'No secrets in this scope yet. Add your first secret above.';
}
function openProject(project = '') {
  $('project').value = project;
  $('project').readOnly = Boolean(project);
  $('environment').value = project ? '' : 'dev';
  $('project-dialog-title').textContent = project ? '$ project add --env' : '$ project add';
  $('project-dialog-description').textContent = project ? `Add environments to ${project}.` : 'Register a project and its environments in the vault.';
  $('project-error').textContent = '';
  $('project-dialog').showModal();
}
function openSecret(key = '') {
  if (!snapshot) throw new Error('Connect your vault first.');
  $('key').value = key;
  $('value').value = '';
  $('secret-target').textContent = `Saving to ${scopeLabel()}.`;
  $('secret-dialog-title').textContent = key ? '$ set // update secret' : '$ set // new secret';
  $('secret-error').textContent = '';
  $('secret-dialog').showModal();
}
async function action(name, data = {}) {
  switch (name) {
    case 'access': $('access-error').textContent = ''; $('access-dialog').showModal(); return;
    case 'browse': { const directory = await window.envvault.chooseDirectory(); if (directory) { $('cwd').value = directory; disconnect(); } return; }
    case 'connect': await refresh(); $('access-dialog').close(); return;
    case 'bootstrap':
      try { await refresh(); } catch { $('status').textContent = 'Connect your vault to get started'; $('console').open = false; }
      return;
    case 'refresh': if (!snapshot && !currentTarget && !$('password').value) { $('access-dialog').showModal(); return; } return refresh();
    case 'init':
      if ($('password').value.length < 8) throw new Error('Enter a master password of at least 8 characters.');
      if (!confirm('Initialize a vault with this password? Keep it safe; it cannot be recovered.')) return;
      await run(['init']); await refresh(); $('access-dialog').close(); return;
    case 'unlock': await run(['unlock', '--ttl', required('session-ttl')]); await refresh(); $('password').value = ''; $('access-dialog').close(); return;
    case 'lock':
      if ([...terminalSessions.values()].some(session => session.running) && !confirm('Lock the vault and stop all embedded commands and servers?')) return;
      await window.envvault.stopTerminals(); clearSensitive(); disposeTerminals(); disconnect(); if (!currentTarget) await run(['lock']); return;
    case 'clear': clearSensitive(); return;
    case 'target': return setTarget(data.id);
    case 'server-save': {
      const saved = await window.envvault.saveServer({ name: $('server-name').value, url: $('server-url').value, token: $('server-token').value });
      $('server-token').value = '';
      $('server-name').value = '';
      $('server-url').value = '';
      await loadServers();
      $('status').textContent = `Saved ${saved.name}. Choose it as the target to connect.`;
      return;
    }
    case 'server-remove': {
      const server = servers.find(candidate => candidate.id === data.id);
      if (!confirm(`Forget the saved token for ${server?.name ?? 'this server'}? You will need the token again to reconnect.`)) return;
      await window.envvault.removeServer(data.id);
      if (currentTarget === data.id) await setTarget('');
      await loadServers();
      return;
    }
    case 'new-project': openProject(); return;
    case 'new-environment': openProject(data.project); return;
    case 'save-project':
      await run(['project', 'add', required('project'), '--env', required('environment')]);
      selected = { kind: 'environment', project: required('project'), environment: required('environment').split(',')[0].trim() };
      await refresh(); $('project-dialog').close(); return;
    case 'remove-project':
      if (!confirm(`Permanently remove ${data.project} and all its secrets?`)) return;
      await run(['project', 'remove', data.project, '--yes']); return refresh();
    case 'global': data = { kind: 'global' }; // fall through
    case 'select':
      if (!snapshot) { $('access-dialog').showModal(); return; }
      selected = data.kind === 'global' ? { kind: 'global' } : { kind: data.kind, project: data.project, ...(data.kind === 'environment' ? { environment: data.environment } : {}) };
      $('secret-search').value = ''; view('overview'); renderOverview(); await loadSecrets();
      $('secret-panel').scrollIntoView({ behavior: 'auto', block: 'start' }); return;
    case 'bind': await run(['use', `${selected.project}/${selected.environment}`]); return;
    case 'new-secret': openSecret(); return;
    case 'edit-secret': openSecret(data.key); return;
    case 'save-secret': await run(['set', required('key'), '--stdin', ...scopeArgs()], $('value').value + '\n'); $('value').value = ''; await refresh(); $('secret-dialog').close(); return;
    case 'reveal':
      if (revealed.has(data.key)) revealed.delete(data.key);
      else if (confirm(`Reveal ${data.key} in plaintext?`)) revealed.set(data.key, (await run(['get', data.key, '--raw', ...scopeArgs()], '', false)).replace(/\r?\n$/, ''));
      renderSecrets(); return;
    case 'copy': await copySecret(data.key); return;
    case 'bulk-reveal':
    case 'bulk-copy':
    case 'bulk-export': return bulkAction(name, data);
    case 'delete-secret': {
      const target = data.origin === 'global' ? { kind: 'global' } : data.origin === 'project' ? { kind: 'shared', project: selected.project } : selected;
      if (!confirm(`Permanently delete ${data.key} from ${scopeLabel(target)}? Inherited keys are removed from their original scope and may affect other environments.`)) return;
      await run(['delete', data.key, '--yes', ...scopeArgs(target)]); return refresh();
    }
    case 'help': await run(['--help']); return;
    case 'operation': return runOperation(data.operation);
    case 'operation-terminal': return runOperation(data.operation, true);
    case 'operation-file': {
      const file = await window.envvault.chooseFile(data.mode);
      if (file) $(`operation-${data.operation}`).elements.namedItem(data.field).value = file;
      return;
    }
    case 'terminal-ui': if (confirm('Start the original interactive UI? Stop it before using other vault controls; it keeps a vault snapshot in memory.')) await launchTerminal(['ui']); return;
    case 'terminal-interrupt': window.envvault.writeTerminal($('terminal-session').value, '\x03'); return;
    case 'terminal-stop': return window.envvault.stopTerminal($('terminal-session').value);
    case 'terminal-clear': { const session = terminalSessions.get($('terminal-session').value); if (session) { session.terminal.reset(); session.terminal.clearSelection(); } return; }
    case 'terminal-remove': {
      const session = terminalSessions.get($('terminal-session').value);
      if (!session) return;
      if (session.running && !confirm('Stop this process and discard its terminal output?')) return;
      await window.envvault.stopTerminal(session.id);
      session.terminal.dispose(); session.container.remove(); session.option.remove(); terminalSessions.delete(session.id);
      if (!terminalSessions.size) $('terminal-session').add(new Option('No sessions', ''));
      selectTerminal(); updateTerminalCount(); return;
    }
    case 'custom': {
      const args = [$('command').value, ...$('args').value.split(/\r?\n/).filter(line => line !== '')];
      if (!confirm(`Run this command? It may modify files, expose secrets, or execute programs.\n\nenvvault ${args.map(arg => JSON.stringify(arg)).join(' ')}`)) return;
      if ($('command-terminal').checked || ['ui', 'serve', 'run', 'copy'].includes(args[0]) || (args[0] === 'docker' && args[1] !== 'plan')) {
        if ($('input').value) throw new Error('For live commands, type standard input directly in the terminal. Clear the buffered input field first.');
        await launchTerminal(args); return;
      }
      const restoring = args[0] === 'sync' && args[1] === 'pull';
      if (restoring) await window.envvault.stopTerminals();
      await run(args, $('input').value);
      $('input').value = '';
      if (args[0] === 'lock') { clearSensitive(); disposeTerminals(); disconnect(); }
      else if (restoring) { $('password').value = ''; disconnect(); }
      else if (snapshot) await refresh();
      return;
    }
  }
}
async function perform(name, data = {}, errorId) {
  if (busy) return;
  if (['operation', 'operation-terminal'].includes(name) && !$(`operation-${data.operation}`).reportValidity()) return;
  busy = true;
  document.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = true; });
  $('status').textContent = 'Working…';
  try {
    await action(name, data);
    if ($('status').textContent === 'Working…') $('status').textContent = 'Ready';
  } catch (error) {
    $('status').textContent = 'Action failed';
    if (!error.commandOutput) $('output').textContent = error.message;
    $('console').open = true;
    const openDialog = document.querySelector('dialog[open]');
    const target = errorId || (openDialog?.id === 'access-dialog' ? 'access-error' : openDialog?.id === 'project-dialog' ? 'project-error' : openDialog?.id === 'secret-dialog' ? 'secret-error' : null);
    if (target) $(target).textContent = error.message;
  } finally {
    busy = false;
    document.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = false; });
  }
}
document.addEventListener('click', event => {
  const element = event.target.closest('button');
  if (!element || busy) return;
  if (element.dataset.close) { $(element.dataset.close).close(); return; }
  if (element.dataset.view) { view(element.dataset.view); return; }
  if (element.dataset.action) {
    const data = { ...element.dataset };
    if (element.closest('.card-bulk-actions')) data.scope = element.closest('.project-card').querySelector('.card-bulk-scope').value;
    perform(element.dataset.action, data);
  }
});
for (const [form, action, error] of [['access-form', 'connect', 'access-error'], ['project-form', 'save-project', 'project-error'], ['secret-form', 'save-secret', 'secret-error']]) {
  $(form).addEventListener('submit', event => { event.preventDefault(); perform(action, {}, error); });
}
$('secret-dialog').addEventListener('close', () => { $('value').value = ''; });
$('project-search').addEventListener('input', renderOverview);
$('target-select').addEventListener('change', () => perform('target', { id: $('target-select').value }));
$('server-form').addEventListener('submit', event => { event.preventDefault(); perform('server-save', {}, 'server-error'); });
$('secret-search').addEventListener('input', renderSecrets);
renderOverview();
window.envvault.defaults().then(async defaults => {
  $('cwd').value = defaults.cwd;
  await loadServers();
  // An existing CLI unlock session can populate the dashboard without a password.
  await perform('bootstrap');
}).catch(error => { $('status').textContent = error.message; });
