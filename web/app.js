'use strict';
import { TranscriptRenderer } from './transcript.ts';
const $ = id => document.getElementById(id);
const transcript = new TranscriptRenderer($('transcript'), {
  copy: async text => {
    if (window.MushiNative) await request('/native/copy-text', 'POST', { text });
    else await navigator.clipboard.writeText(text);
  },
  openLink: url => action(() => request('/native/open-link', 'POST', { url })),
});
const pending = new Map();
let connected = false, configured = false, catalog = [], lastView = '', sending = false, currentModel;
let authState, authBusy = false, authFingerprint = '';
const deviceProvider = provider => provider === 'openai-codex' || provider === 'github-copilot';
const pendingLogin = login => login && ['starting', 'waiting', 'authorizing'].includes(login.phase);
window.mushiError = text => { $('notice').textContent = text; $('notice').hidden = false; };
window.mushiReply = (id, response) => {
  const call = pending.get(id);
  if (!call) return;
  pending.delete(id); clearTimeout(call.timer);
  response.error ? call.reject(new Error(response.error)) : call.resolve(response.value);
};
function request(path, method = 'GET', body = {}) {
  return new Promise((resolve, reject) => {
    if (!window.MushiNative) return reject(new Error('Open this UI inside the Mushi Android app.'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent request timed out')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    window.MushiNative.postMessage(JSON.stringify({ id, path, method, body }));
  });
}
async function action(fn) {
  try { await fn(); $('notice').hidden = true; }
  catch (error) { window.mushiError(error.message); }
}
function render(view) {
  const live = view.docs['pi.live'] || {}, inbox = view.docs['pi.inbox']?.items || [];
  const serialized = JSON.stringify(view);
  if (serialized === lastView) return;
  lastView = serialized;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 130;
  transcript.render(view);
  const running = (live.tools || []).filter(tool => tool.status === 'running');
  $('status').textContent = live.run ? running.length ? `Running ${running.map(tool => tool.name).join(', ')}` : 'Working…' : 'Ready';
  $('queue').hidden = !inbox.length;
  $('queue').textContent = inbox.length ? `${inbox.length} queued` : '';
  const retry = live.generation?.retry;
  const activity = retry ? `Retrying after: ${retry.error}` : live.generation?.deferred ? 'Waiting for a response…' :
    live.compactions?.length ? 'Compacting the conversation…' : live.compactionFailure?.error || '';
  $('tasks').hidden = !activity;
  $('activity').textContent = activity;
  $('abort').disabled = !live.run;
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}
function fillModels(selected) {
  $('model').replaceChildren();
  for (const item of catalog.filter(m => m.provider === $('provider').value)) {
    const option = document.createElement('option'); option.value = item.modelId; option.textContent = item.name || item.modelId;
    option.selected = item.modelId === selected; $('model').append(option);
  }
}
function renderAuth() {
  const provider = $('provider').value;
  const account = authState?.providers.find(item => item.id === provider);
  const login = authState?.login;
  const active = pendingLogin(login), own = login?.provider === provider;
  authBusy = !!active;
  $('apiKeyRow').hidden = deviceProvider(provider);
  $('signIn').hidden = !deviceProvider(provider);
  $('signIn').disabled = !!active || !connected;
  $('signIn').textContent = account?.connected ? 'Sign in again' : 'Sign in';
  $('cancelLogin').hidden = !active;
  $('logout').hidden = !account?.connected;
  $('logout').textContent = account?.method === 'api_key' ? 'Remove API key' : 'Sign out';
  $('authStatus').textContent = active && !own ? 'Finish or cancel the pending sign-in.' :
    own ? login.message : account?.connected ? (account.method === 'oauth' ? 'Signed in.' : 'API key saved.') : 'Not signed in.';
  if (own && account?.connected && ['cancelled', 'expired', 'error'].includes(login.phase)) $('authStatus').textContent += ' Your previous sign-in is unchanged.';
  $('deviceInfo').hidden = !active || !own || !login.device;
  if (active && own && login.device) {
    $('userCode').textContent = login.device.userCode;
    $('verificationSite').textContent = login.device.verificationUri;
    const remaining = Math.max(0, Math.ceil((login.device.expiresAt - Date.now()) / 1000));
    $('codeExpiry').textContent = remaining ? `Expires in ${Math.floor(remaining / 60)}m ${remaining % 60}s` : 'Code expired; start a new sign-in.';
    $('authBrowser').disabled = $('authCopy').disabled = !remaining;
  } else { $('userCode').textContent = ''; $('verificationSite').textContent = ''; }
  $('providerHint').textContent = provider === 'github-copilot' ? 'Requires Copilot access. Git repository sign-in is separate.' :
    provider === 'openai-codex' ? 'Uses your ChatGPT subscription.' : provider === 'openai' ? 'Uses API billing.' : '';
  $('providerHint').hidden = !$('providerHint').textContent;
  $('saveConfig').disabled = !!active || (deviceProvider(provider) && !account?.connected) || !$('model').options.length;
}
async function reloadModels() {
  const provider = $('provider').value, selected = $('model').value;
  catalog = await request('/api/models');
  fillModels(provider === $('provider').value ? selected : $('model').value);
}
async function refreshAuth() {
  authState = await request('/api/auth');
  const fingerprint = JSON.stringify([authState.providers, authState.login?.id, authState.login?.phase]);
  if (fingerprint !== authFingerprint) {
    authFingerprint = fingerprint;
    await reloadModels();
  }
  renderAuth();
}
async function settings() {
  authState = await request('/api/auth');
  if (pendingLogin(authState.login)) $('provider').value = authState.login.provider;
  else if (currentModel) $('provider').value = currentModel.provider;
  catalog = await request('/api/models');
  fillModels(currentModel?.provider === $('provider').value ? currentModel.modelId : undefined);
  renderAuth();
  $('settings').hidden = false;
}
async function flushOutbox() {
  if (sending || !connected || !configured || authBusy) return;
  const saved = localStorage.getItem('mushi.outbox');
  if (!saved) return;
  sending = true; $('send').disabled = true;
  try {
    // The same ID is retained until durable admission is acknowledged.
    await request('/api/submit', 'POST', JSON.parse(saved));
    localStorage.removeItem('mushi.outbox');
    $('message').value = '';
    $('notice').hidden = true;
  } catch (error) { window.mushiError(`${error.message}. Message retained; reconnecting will retry the same request ID.`); }
  finally { sending = false; $('send').disabled = !!localStorage.getItem('mushi.outbox'); }
}
async function poll() {
  try {
    const state = await request('/api/state');
    connected = true; configured = state.configured; currentModel = state.model; authBusy = state.authBusy;
    $('start').hidden = true; $('stop').hidden = false;
    $('send').disabled = sending || !!localStorage.getItem('mushi.outbox') || !configured || authBusy;
    $('modelLabel').textContent = state.model ? (catalog.find(model => model.provider === state.model.provider && model.modelId === state.model.modelId)?.name || state.model.modelId) : 'Choose a model in Settings';
    render(state.view);
    if (!$('settings').hidden || authBusy || pendingLogin(authState?.login)) await refreshAuth();
    await flushOutbox();
  } catch (error) {
    connected = false; lastView = '';
    $('status').textContent = 'Stopped';
    $('start').hidden = false; $('stop').hidden = true;
    $('send').disabled = true;
  } finally { setTimeout(poll, connected ? 750 : 2500); }
}
$('start').onclick = () => action(async () => {
  $('start').disabled = true;
  try { await request('/native/start', 'POST'); $('status').textContent = 'Starting…'; }
  finally { setTimeout(() => { $('start').disabled = false; }, 4000); }
});
$('stop').onclick = () => action(async () => {
  if (confirm('Stop the agent? You can resume later.')) await request('/native/stop', 'POST');
});
$('terminal').onclick = () => action(() => request('/native/terminal', 'POST'));
$('logs').onclick = () => action(async () => {
  const log = await request('/native/log'); $('logPanel').hidden = false; $('logPanel').open = true; $('logText').textContent = log.text;
  $('settings').hidden = true; $('logPanel').scrollIntoView({ block: 'start' });
});
$('settingsButton').onclick = () => action(async () => {
  if (!$('settings').hidden) { $('settings').hidden = true; return; }
  await settings();
});
$('licenses').onclick = () => action(async () => {
  const result = await request('/native/licenses'); $('logPanel').hidden = false; $('logPanel').open = true; $('logText').textContent = result.text;
  $('settings').hidden = true; $('logPanel').scrollIntoView({ block: 'start' });
});
$('provider').onchange = () => { $('key').value = ''; fillModels(); renderAuth(); };
$('signIn').onclick = () => action(async () => {
  $('signIn').disabled = true;
  authState = await request('/api/auth/start', 'POST', { provider: $('provider').value });
  renderAuth();
});
$('cancelLogin').onclick = () => action(async () => {
  if (authState?.login) authState = await request('/api/auth/cancel', 'POST', { id: authState.login.id });
  renderAuth();
});
$('logout').onclick = () => action(async () => {
  if (!confirm(deviceProvider($('provider').value) ? 'Sign out of this provider?' : 'Remove this API key?')) return;
  authState = await request('/api/auth/logout', 'POST', { provider: $('provider').value });
  $('key').value = ''; await reloadModels(); renderAuth();
});
$('authBrowser').onclick = () => action(() => request('/native/auth-browser', 'POST', { provider: $('provider').value }));
$('authCopy').onclick = () => action(() => request('/native/auth-copy', 'POST', { provider: $('provider').value }));
$('config').onsubmit = e => { e.preventDefault(); void action(async () => {
  const provider = $('provider').value;
  await request('/api/config', 'POST', { provider, modelId: $('model').value, ...(deviceProvider(provider) ? {} : { apiKey: $('key').value }) });
  $('key').value = ''; $('settings').hidden = true;
}); };
$('prompt').onsubmit = e => { e.preventDefault(); void action(async () => {
  if (localStorage.getItem('mushi.outbox')) throw new Error('A message is awaiting acknowledgement. It will retry on reconnect.');
  const text = $('message').value.trim(); if (!text) return;
  localStorage.setItem('mushi.outbox', JSON.stringify({ requestId: crypto.randomUUID(), text, whenBusy: $('mode').value }));
  await flushOutbox();
}); };
$('abort').onclick = () => action(() => request('/api/abort', 'POST'));
$('reset').onclick = () => action(async () => {
  if (confirm('Start a new model context? Stored history is retained.')) await request('/api/reset', 'POST');
});
$('send').disabled = true;
void poll();
