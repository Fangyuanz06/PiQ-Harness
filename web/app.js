'use strict';

const $ = id => document.getElementById(id);
const state = {
  csrfToken: '', groups: [], selected: null, detail: null, defaultWsUrl: 'ws://127.0.0.1:3001/',
  tab: 'documents', document: 'PERSONA.md', documentText: '', documentRevision: '', documentLoaded: false,
  configText: '', configRevision: '', detailSequence: 0, documentSequence: 0, logSequence: 0,
  membershipSaved: '', membershipLoaded: false, membershipOutdated: false, configLoading: false, logConversation: '',
  models: null, modelCatalogError: '', modelSaved: '', modelRevision: '', modelLoaded: false, modelSequence: 0,
  modelRuntime: null, modelPendingRequestId: null, modelAwaitStarted: 0, modelAwaitTimedOut: false, modelRuntimeLoading: false,
  busy: false, loadingState: false, poll: null, groupPending: new Map(),
  slangEntries: [], slangConversations: [], slangSequence: 0, slangLoading: false,
  runPending: new Map(), runPoll: null, terminalPending: new Set(),
  serviceCache: new Map(), servicePending: new Map(),
};

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}

async function api(path, options = {}) {
  const mutation = options.method && options.method !== 'GET';
  const response = await fetch(path, {
    ...options,
    headers: { ...(mutation ? { 'Content-Type': 'application/json', 'X-PiQ-Token': state.csrfToken } : {}), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || result.message || `请求失败（${response.status}）`);
    error.response = result; error.status = response.status;
    throw error;
  }
  return result;
}

const groupUrl = (id = state.selected) => `/api/groups/${encodeURIComponent(id)}`;
const documentUrl = (filename, id = state.selected) => filename === 'ROOT_AGENTS.md'
  ? '/api/root/agents' : `${groupUrl(id)}/documents/${encodeURIComponent(filename)}`;
const documentLabel = filename => filename === 'ROOT_AGENTS.md' ? '公共 AGENTS.md' : filename === 'AGENTS.md' ? '本对话组 AGENTS.md' : filename;
function documentDirty() { return state.documentLoaded && $('document-content').value !== state.documentText; }
const permissionKeys = ['commands', 'fileRead', 'fileWrite', 'qq', 'network', 'otherTools'];
const permissionFields = () => Object.fromEntries(permissionKeys.map(key => [key, $('permission-' + key).checked]));
function connectionFields() {
  return {
    wsUrl: $('ws-url').value.trim(), accessTokenEnv: $('token-env').value.trim(),
    quietMs: Number($('quiet-ms').value), maxWaitMs: Number($('max-wait-ms').value),
    minIntervalMs: Number($('min-interval-ms').value), permissions: permissionFields(),
  };
}
function configValue() { return { ...state.detail?.config, ...connectionFields() }; }
function configDirty() { return !!state.detail && JSON.stringify(connectionFields()) !== state.configText; }
const conversationKey = conversation => conversation.type === 'temporary' ? `temporary:${conversation.sourceGroupId}:${conversation.id}` : `${conversation.type}:${conversation.id}`;
const conversationLabel = conversation => `${conversation.name ? `${conversation.name} · ` : ''}${conversation.type === 'group' ? '群聊' : conversation.type === 'temporary' ? '临时私聊' : '私聊'} ${conversation.id}${conversation.type === 'temporary' ? `（来自群 ${conversation.sourceGroupId}）` : ''}`;
function conversationFromKey(key) {
  const temporary = /^temporary:([1-9]\d*):([1-9]\d*)$/.exec(key);
  if (temporary) return { type: 'temporary', sourceGroupId: temporary[1], id: temporary[2] };
  const match = /^(group|private):([1-9]\d*)$/.exec(key);
  return match ? { type: match[1], id: match[2] } : null;
}
function pendingByConversation() {
  const group = state.groups.find(item => item.id === state.selected);
  const runtime = group?.runtime === undefined ? state.detail?.runtime : group.runtime;
  return new Map((runtime?.pendingConversations || []).filter(item => conversationFromKey(item.key)
    && Number.isSafeInteger(item.count) && item.count > 0).map(item => [item.key, item.count]));
}
function currentConversation(key) {
  const group = state.groups.find(item => item.id === state.selected);
  return (group?.conversations || state.detail?.config.conversations || []).find(item => conversationKey(item) === key) || conversationFromKey(key);
}
function logConversationLabel(key) {
  const conversation = currentConversation(key);
  if (!conversation) return key;
  const count = pendingByConversation().get(key);
  return `${conversationLabel(conversation)}${count ? ` · 待处理 ${count}` : ''}`;
}
function readConversationRows(container) {
  return [...$(container).querySelectorAll('.conversation-row')].map(row => {
    const value = { type: row.querySelector('[data-field="type"]').value, id: row.querySelector('[data-field="id"]').value.trim() };
    if (value.type === 'temporary') value.sourceGroupId = row.querySelector('[data-field="sourceGroupId"]').value.trim();
    const name = row.querySelector('[data-field="name"]').value.trim();
    if (name) value.name = name;
    return value;
  });
}
function membershipValue() { return { name: $('group-name').value.trim(), conversations: readConversationRows('conversation-rows') }; }
function membershipDirty() { return state.membershipLoaded && JSON.stringify(membershipValue()) !== state.membershipSaved; }
function membershipLocked() {
  const group = state.groups.find(item => item.id === state.selected);
  return !!(group?.running || group?.starting || state.runPending.has(state.selected) || state.terminalPending.has(state.selected));
}
function validateConversations(values) {
  const result = [], keys = new Set();
  for (const value of values) {
    if (!value.id && !value.name && !value.sourceGroupId) continue;
    if (!['group', 'private', 'temporary'].includes(value.type) || !/^[1-9]\d*$/.test(value.id) || !Number.isSafeInteger(Number(value.id))) throw new Error('请为每个对话填写有效的群号或 QQ 号。');
    if (value.type === 'temporary' && (!/^[1-9]\d*$/.test(value.sourceGroupId) || !Number.isSafeInteger(Number(value.sourceGroupId)))) throw new Error('临时私聊还需要填写有效的来源群号。');
    const key = conversationKey(value);
    if (keys.has(key)) throw new Error(`${conversationLabel(value)} 在本组重复了，请只保留一项。`);
    keys.add(key); result.push(value);
  }
  return result;
}
let conversationRowSequence = 0;
function addConversationRow(container, value = { type: 'group', id: '' }) {
  const row = document.createElement('div'); row.className = 'conversation-row';
  const sequence = ++conversationRowSequence;
  const addField = (label, element, field) => {
    const wrapper = document.createElement('div'); wrapper.className = `field conversation-${field}`;
    const caption = document.createElement('label'); caption.textContent = label;
    element.id = `conversation-${sequence}-${field}`; caption.htmlFor = element.id; element.dataset.field = field;
    wrapper.append(caption, element); row.append(wrapper); return element;
  };
  const type = document.createElement('select');
  for (const [id, name] of [['group', '群聊'], ['private', '私聊'], ['temporary', '群临时私聊']]) { const option = document.createElement('option'); option.value = id; option.textContent = name; type.append(option); }
  type.value = value.type; addField('类型', type, 'type');
  const id = document.createElement('input'); id.type = 'text'; id.inputMode = 'numeric'; id.autocomplete = 'off'; id.maxLength = 16; id.pattern = '[1-9][0-9]*'; id.value = value.id;
  id.placeholder = '群号或 QQ 号'; addField('对话号码', id, 'id');
  const sourceGroupId = document.createElement('input'); sourceGroupId.type = 'text'; sourceGroupId.inputMode = 'numeric'; sourceGroupId.autocomplete = 'off'; sourceGroupId.maxLength = 16; sourceGroupId.pattern = '[1-9][0-9]*'; sourceGroupId.value = value.sourceGroupId || '';
  sourceGroupId.placeholder = '来源群号'; addField('来源群号', sourceGroupId, 'sourceGroupId');
  const updateTemporary = () => {
    const temporary = type.value === 'temporary';
    row.classList.toggle('temporary', temporary);
    sourceGroupId.parentElement.hidden = !temporary;
    sourceGroupId.disabled = !temporary;
  };
  type.addEventListener('change', updateTemporary); updateTemporary();
  const name = document.createElement('input'); name.type = 'text'; name.autocomplete = 'off'; name.maxLength = 80; name.value = value.name || ''; name.placeholder = '可选'; addField('备注名称', name, 'name');
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button subtle remove-conversation'; remove.textContent = '移除'; remove.setAttribute('aria-label', '移除此对话');
  remove.addEventListener('click', () => { row.remove(); if (container === 'conversation-rows') updateMembershipState(); });
  row.append(remove); $(container).append(row);
  row.addEventListener('input', () => { if (container === 'conversation-rows') updateMembershipState(); });
  row.addEventListener('change', () => { if (container === 'conversation-rows') updateMembershipState(); });
  if (container === 'conversation-rows') updateMembershipState();
}
function updateMembershipState() {
  const dirty = membershipDirty(), locked = membershipLocked(), enabled = state.membershipLoaded && !locked && !state.busy && !state.configLoading;
  $('membership-lock').hidden = !locked;
  $('membership-outdated').hidden = !state.membershipOutdated;
  $('reload-config').disabled = !state.detail || state.busy || state.configLoading;
  $('reload-config').textContent = state.configLoading ? '正在读取…' : '重新读取配置';
  $('membership-state').textContent = !state.membershipLoaded ? '正在读取…' : dirty ? '有未保存的修改' : `${state.detail.config.conversations.length} 个对话 · 已保存`;
  $('membership-state').classList.toggle('dirty', dirty);
  $('group-name').disabled = !enabled;
  $('add-conversation').disabled = !enabled;
  for (const row of $('conversation-rows').querySelectorAll('.conversation-row')) {
    const temporary = row.querySelector('[data-field="type"]').value === 'temporary';
    row.querySelectorAll('input,select,button').forEach(input => {
      input.disabled = !enabled || (input.dataset.field === 'sourceGroupId' && !temporary);
    });
  }
  $('save-membership').disabled = !enabled || !dirty;
}
function modelValue() {
  const value = {};
  if ($('model-choice').value) {
    const [provider, model] = JSON.parse($('model-choice').value);
    value.provider = provider; value.model = model;
  }
  if ($('thinking-choice').value) value.thinkingLevel = $('thinking-choice').value;
  return value;
}
function modelDirty() { return state.modelLoaded && JSON.stringify(modelValue()) !== state.modelSaved; }
function mayDiscard() {
  return !(documentDirty() || configDirty() || membershipDirty() || modelDirty()) || window.confirm('当前修改尚未保存，切换后将丢弃这些修改。继续吗？');
}

function updateDocumentState(saved = false) {
  const dirty = documentDirty();
  $('document-state').classList.toggle('dirty', dirty);
  $('document-state').textContent = !state.documentLoaded ? '正在读取…' : dirty ? '有未保存的修改' : saved ? '已保存' : `${$('document-content').value.length.toLocaleString()} 字符 · 已保存`;
  $('save-document').disabled = !state.documentLoaded || !dirty || state.busy;
}

function updateConfigState() {
  const dirty = configDirty();
  $('config-state').classList.toggle('dirty', dirty);
  $('config-state').textContent = dirty ? '有未保存的修改' : '已保存';
  $('save-config').disabled = !dirty || state.busy || state.configLoading;
}

function renderGroups() {
  const list = $('group-list');
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.groupId : null;
  list.replaceChildren();
  $('group-count').textContent = String(state.groups.length);
  for (const group of state.groups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.groupId = group.id;
    button.className = `group-item${state.selected === group.id ? ' active' : ''}`;
    if (state.selected === group.id) button.setAttribute('aria-current', 'true');
    button.title = group.error || group.path;
    const icon = document.createElement('span'); icon.className = 'group-icon'; icon.textContent = '#'; icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'group-item-text';
    const title = document.createElement('span'); title.className = 'group-item-title'; title.textContent = group.name || group.id;
    const sub = document.createElement('span'); sub.className = 'group-item-subtitle';
    sub.textContent = !group.running ? `${group.conversations?.length ?? 0} 个对话` : group.runtime?.paused ? 'Pi 已暂停' : group.runtime?.mode === 'background' ? 'Pi 后台运行' : 'Pi 正在运行';
    text.append(title, sub); button.append(icon, text);
    if (group.running) { const dot = document.createElement('span'); dot.className = `live-dot${group.runtime?.paused ? ' paused' : ''}`; dot.setAttribute('aria-label', group.runtime?.paused ? '已暂停' : '正在运行'); button.append(dot); }
    button.addEventListener('click', () => selectGroup(group.id));
    list.append(button);
    if (focusedId === group.id) button.focus({ preventScroll: true });
  }
  if (!state.groups.length) { const empty = document.createElement('p'); empty.className = 'sidebar-empty'; empty.textContent = '对话组目录还空着'; list.append(empty); }
  renderRunStatus();
}

function renderRunStatus() {
  const current = state.groups.find(group => group.id === state.selected);
  const running = !!current?.running;
  const starting = !!current?.starting;
  const runtime = current?.runtime === undefined ? state.detail?.runtime : current.runtime;
  const paused = running && !!runtime?.paused;
  const pending = state.runPending.get(state.selected);
  const terminalPending = state.terminalPending.has(state.selected);
  const service = current?.service || state.serviceCache.get(state.selected) || state.detail?.service;
  const servicePending = state.servicePending.get(state.selected);
  $('run-status').textContent = starting ? 'Pi 启动中' : !running ? 'Pi 未运行' : paused ? 'Pi 已暂停' : 'Pi 已运行';
  $('run-status').classList.toggle('running', running && !paused);
  $('run-status').classList.toggle('paused', paused);
  $('run-status').title = running && current.pid ? `进程 ${current.pid}` : '';
  const connection = running ? runtime?.connection : service?.ok ? 'ready' : 'disconnected';
  const connectionLabels = { connected: 'SnowLuma 已连接', ready: 'SnowLuma 已就绪', connecting: 'SnowLuma 连接中', disconnected: 'SnowLuma 未连接', error: 'SnowLuma 连接异常' };
  $('connection-status').textContent = connectionLabels[connection] || '连接状态待更新';
  $('connection-status').className = `connection-status ${connection || 'unknown'}`;
  $('connection-status').title = ['connected', 'ready'].includes(connection) ? '' : runtime?.lastError || service?.diagnostic || '';
  $('terminal-note').textContent = !running ? '继续本对话组最近的会话' : runtime?.mode === 'background' ? '本对话组会话在后台运行' : runtime?.mode === 'terminal' ? '本对话组会话已在终端中运行' : '本对话组会话正在运行';
  const descriptions = [];
  if (state.detail && !running && !starting && !state.detail.config.conversations.length) descriptions.push('添加并保存至少一个对话后即可启动 Pi');
  if (paused) descriptions.push('暂停中，消息继续保存');
  else if (running) descriptions.push(runtime?.mode === 'background' ? 'Pi 在后台运行' : runtime?.mode === 'terminal' ? 'Pi 在终端运行' : 'Pi 进程已启动');
  if (running && Number.isFinite(runtime?.pendingCount) && runtime.pendingCount > 0) descriptions.push(`待处理 ${runtime.pendingCount} 条消息`);
  if (running && runtime?.lastError) descriptions.push(runtime.lastError);
  else if (running && ['disconnected', 'error'].includes(connection)) descriptions.push('等待 SnowLuma 连接，暂时无法发送 QQ 消息');
  else if (running && !runtime) descriptions.push('等待会话状态；旧终端请执行 /reload');
  $('run-description').textContent = descriptions.join(' · ');
  $('run-description').classList.toggle('error', running && (connection === 'error' || !!runtime?.lastError));
  $('run-description').hidden = !descriptions.length;
  const classified = $('pending-dialogs'); classified.replaceChildren();
  for (const [key, count] of pendingByConversation()) {
    const source = currentConversation(key);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'pending-dialog';
    button.textContent = `${conversationLabel(source)} · ${count} 条`;
    button.addEventListener('click', () => { state.logConversation = key; setTab('messages'); });
    classified.append(button);
  }
  classified.hidden = !running || !classified.children.length;
  for (const option of $('log-conversation').options) if (option.value) option.textContent = logConversationLabel(option.value);
  const action = !running ? 'start' : paused ? 'resume' : 'pause';
  $('run-action').dataset.action = action;
  $('run-action').textContent = pending ? ({ start: '正在启动…', pause: '正在暂停…', resume: '正在恢复…', stop: '正在停止…' }[pending.action]) : ({ start: '启动 Pi', pause: '暂停', resume: '恢复运行' }[action]);
  const noConversations = !state.detail?.config.conversations.length;
  $('run-action').disabled = !state.detail || !!pending || starting || terminalPending || !!servicePending || (!running && noConversations);
  $('stop-run').hidden = !running;
  $('stop-run').disabled = !running || !!pending || terminalPending || !!servicePending;
  $('stop-run').textContent = pending?.action === 'stop' ? '正在停止…' : '停止';
  $('open-terminal').disabled = !state.detail || !!pending || starting || terminalPending || !!servicePending || noConversations;
  $('open-terminal').title = running && runtime?.mode === 'background' ? '将当前会话交给交互终端继续' : running ? '查看已有 Pi 终端' : '在交互终端中继续本对话组会话';
  $('service-recovery').hidden = !state.detail || runtime?.connection === 'connected';
  $('service-recovery').classList.toggle('error', service?.ok === false && !servicePending);
  $('service-message').textContent = servicePending
    ? servicePending === 'recover' ? '正在检查并尝试连接 SnowLuma…' : '正在打开 SnowLuma…'
    : service?.message || (running ? 'SnowLuma 尚未连接，可以重试或打开启动窗口检查。' : '启动 Pi 时会先检查 SnowLuma，也可以在这里检查服务。');
  $('service-diagnostic').textContent = service?.diagnostic || '';
  $('service-diagnostic').hidden = !service?.diagnostic;
  $('recover-connection').disabled = !state.detail || !!servicePending || !!pending || terminalPending;
  const cannotOpenManual = service?.canOpenManual === false && !service?.manualUrl;
  $('open-snowluma').disabled = !state.detail || !!servicePending || !!pending || terminalPending || cannotOpenManual;
  $('recover-connection').textContent = servicePending === 'recover' ? '正在重试…' : '重试连接';
  $('open-snowluma').textContent = servicePending === 'snowluma' ? '正在打开…' : '打开 SnowLuma';
  $('open-snowluma').title = cannotOpenManual ? service.diagnostic || service.message || '此连接没有可打开的本机界面，请检查 SnowLuma 安装或远端服务。' : '打开 SnowLuma 界面或启动窗口，查看登录和运行情况';
  if (current?.name) $('group-title').textContent = current.name;
  updateMembershipState();
  renderGroupManagement();
}


function renderGroupManagement() {
  const pending = state.groupPending.has(state.selected), stopped = !membershipLocked();
  $('rename-group').disabled = !state.detail || pending || state.busy || state.configLoading;
  $('copy-group').disabled = !state.detail || pending || state.busy || !stopped;
  $('delete-group').disabled = !state.detail || pending || state.busy || !stopped;
  $('group-menu-help').textContent = pending ? '正在处理，请稍候…' : stopped
    ? '复制不带对话成员；删除后数据移到 .trash，可恢复。' : '本组 Pi 正在运行。复制和删除前请先停止；可直接重命名。';
  if (pending) { $('run-action').disabled = true; $('open-terminal').disabled = true; $('stop-run').disabled = true; }
}
function validGroupName(value) {
  const name = value.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('名称须为 1 到 80 个字符，且不含控制字符。');
  return name;
}
function clearGroupSelection() {
  state.selected = null; state.detail = null; state.detailSequence++;
  state.documentSequence++; state.logSequence++; state.modelSequence++; state.slangSequence++;
  state.documentLoaded = false; state.membershipLoaded = false; state.modelLoaded = false;
  state.slangEntries = []; state.slangConversations = []; state.slangLoading = false;
  $('document-content').value = ''; $('group-workspace').hidden = true; $('welcome').hidden = false;
  $('group-menu').open = false;
  try { localStorage.removeItem('piq:selected-group'); } catch { /* Storage is optional. */ }
}
async function manageGroup(action) {
  const id = state.selected, detail = state.detail, sequence = state.detailSequence;
  if (!id || !detail || state.groupPending.has(id) || state.busy) return;
  if (action !== 'rename' && membershipLocked()) { notice('请先停止本组 Pi，再复制或删除对话组。', true); return; }
  if ((membershipDirty() || configDirty()) && action === 'rename') { notice('请先保存或重新读取当前设置，再重命名。', true); return; }
  let name;
  if (action === 'rename' || action === 'copy') {
    const requested = window.prompt(action === 'rename' ? '对话组新名称' : '新副本的名称（对话成员将留空）', action === 'rename' ? detail.config.name : (detail.config.name.slice(0, 77) + ' 副本'));
    if (requested === null) return;
    try { name = validGroupName(requested); } catch (error) { notice(error.message, true); return; }
    if (action === 'rename' && name === detail.config.name) return;
  } else if (action === 'delete') {
    if (!mayDiscard() || !window.confirm('删除对话组“' + detail.config.name + '”？\n\n它会从工作台移除，数据移到根目录的 .trash 中，可手动恢复。此操作不会删除 QQ 群。')) return;
  } else return;
  $('group-menu').open = false;
  state.groupPending.set(id, action); renderRunStatus();
  try {
    if (action === 'rename') {
      const result = await api(groupUrl(id) + '/config', { method: 'PUT', body: { config: { ...detail.config, name }, revision: state.configRevision } });
      const group = state.groups.find(item => item.id === id); if (group) group.name = result.config.name;
      if (id === state.selected && sequence === state.detailSequence) {
        state.detail.config = result.config; state.detail.configRevision = result.revision; state.configRevision = result.revision;
        $('group-name').value = result.config.name; state.membershipSaved = JSON.stringify(membershipValue());
        notice('对话组已重命名为“' + result.config.name + '”。');
      }
      renderGroups();
    } else if (action === 'copy') {
      const result = await api(groupUrl(id) + '/copy', { method: 'POST', body: { name } });
      await refreshState();
      if (id === state.selected && sequence === state.detailSequence && mayDiscard()) await selectGroup(result.id, true);
      notice('已创建副本“' + (result.name || name) + '”。请先在“对话”页添加成员，再启动 Pi。');
    } else {
      const result = await api(groupUrl(id), { method: 'DELETE' });
      state.groups = state.groups.filter(group => group.id !== id);
      state.serviceCache.delete(id); state.runPending.delete(id);
      if (id === state.selected) {
        clearGroupSelection();
        const next = state.groups[0]?.id;
        if (next) await selectGroup(next, true);
      }
      renderGroups();
      await refreshState();
      notice('对话组已移入可恢复目录：' + (result.recoveryPath || '.trash') + '。');
    }
  } catch (error) {
    if (id === state.selected && sequence === state.detailSequence) notice(error.message, true);
  } finally { state.groupPending.delete(id); renderRunStatus(); }
}

function normalizedSlang(value) { return String(value || '').normalize('NFKC').trim().toLocaleLowerCase(); }
function filteredSlang(entries, query, status) {
  const needle = normalizedSlang(query);
  return entries.filter(entry => (status === 'all' || entry.status === status)
    && (!needle || normalizedSlang([entry.term, entry.meaning, entry.usage].join(' ')).includes(needle)));
}
function safeSlangSource(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function renderSlang() {
  const list = $('slang-list'); list.replaceChildren();
  const entries = filteredSlang(state.slangEntries, $('slang-search').value, $('slang-status').value || 'all');
  $('slang-count').textContent = state.slangLoading ? '正在读取…' : entries.length + ' / ' + state.slangEntries.length + ' 个词条';
  $('slang-empty').hidden = state.slangLoading ? false : !!entries.length;
  $('slang-empty-title').textContent = state.slangLoading ? '正在读取梗与黑话…' : !$('slang-error').hidden ? '词库读取失败' : state.slangEntries.length ? '没有符合条件的词条' : '还没有梗与黑话';
  $('slang-empty-help').textContent = state.slangLoading ? '正在读取本组词库。' : !$('slang-error').hidden ? '请检查上方原因，再点击刷新词库重试。' : state.slangEntries.length ? '试试其他关键词或状态。' : 'Agent 会在处理聊天时自主学习，可随时刷新查看。';
  list.hidden = !entries.length;
  const known = new Map(state.slangConversations.map(item => [conversationKey(item), item]));
  const statuses = { candidate: '候选', learned: '已学用法', rejected: '已忽略' };
  for (const entry of entries) {
    const article = document.createElement('article'); article.className = 'slang-entry';
    const heading = document.createElement('div'); heading.className = 'slang-entry-heading';
    const title = document.createElement('h3'); title.textContent = String(entry.term || '未命名词条');
    const status = document.createElement('span'); status.className = 'slang-badge ' + (Object.hasOwn(statuses, entry.status) ? entry.status : 'candidate'); status.textContent = statuses[entry.status] || '候选';
    heading.append(title, status); article.append(heading);
    const fields = document.createElement('dl'); fields.className = 'slang-fields';
    for (const [label, value] of [['含义 · 模型推断', entry.meaning], ['使用场景', entry.usage], ['例句', entry.example], ['注意事项', entry.cautions]]) {
      if (!value) continue;
      const key = document.createElement('dt'); key.textContent = label;
      const text = document.createElement('dd'); text.textContent = String(value); fields.append(key, text);
    }
    if (!entry.meaning && !entry.usage) { const text = document.createElement('p'); text.className = 'slang-unresolved'; text.textContent = '含义与场景尚不明确，等待更多聊天语境。'; article.append(text); }
    article.append(fields);
    const meta = document.createElement('div'); meta.className = 'slang-meta';
    const source = document.createElement('span'); const conversation = known.get(entry.conversation) || conversationFromKey(entry.conversation);
    source.textContent = '来源：' + (conversation ? conversationLabel(conversation) : String(entry.conversation || '历史来源'));
    const evidence = document.createElement('span'); evidence.textContent = (Array.isArray(entry.evidenceSeqs) ? entry.evidenceSeqs.length : 0) + ' 条聊天证据';
    const time = document.createElement('time'); const date = new Date(entry.updatedAt); time.textContent = Number.isFinite(date.getTime()) ? '更新于 ' + date.toLocaleString('zh-CN', { hour12: false }) : '';
    meta.append(source, evidence, time); article.append(meta);
    if (Array.isArray(entry.sources)) {
      const links = document.createElement('div'); links.className = 'slang-sources';
      for (const item of entry.sources) {
        const href = safeSlangSource(item?.url); if (!href) continue;
        const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = String(item.title || '联网来源'); links.append(link);
      }
      if (links.children.length) article.append(links);
    }
    list.append(article);
  }
}
async function loadSlang() {
  const id = state.selected, sequence = ++state.slangSequence;
  if (!id || !state.detail) return;
  state.slangLoading = true; state.slangEntries = []; $('refresh-slang').disabled = true; $('slang-error').hidden = true; renderSlang();
  try {
    const result = await api(groupUrl(id) + '/slang');
    if (id !== state.selected || sequence !== state.slangSequence) return;
    if (!Array.isArray(result.entries) || !Array.isArray(result.conversations)) throw new Error('词库返回格式无效，请刷新后重试。');
    state.slangEntries = result.entries; state.slangConversations = result.conversations;
  } catch (error) {
    if (id !== state.selected || sequence !== state.slangSequence) return;
    $('slang-error').textContent = error.message; $('slang-error').hidden = false;
  } finally {
    if (id === state.selected && sequence === state.slangSequence) { state.slangLoading = false; $('refresh-slang').disabled = false; renderSlang(); }
  }
}

function rememberService(id, result) {
  if (!result || typeof result !== 'object') return;
  const service = result.service && typeof result.service === 'object' ? result.service
    : typeof result.ok === 'boolean' || typeof result.canStart === 'boolean' || typeof result.canOpenManual === 'boolean' || typeof result.manualUrl === 'string' || typeof result.diagnostic === 'string'
      ? { ...result, ok: result.ok === true } : null;
  if (!service) return;
  state.serviceCache.set(id, service);
  const group = state.groups.find(item => item.id === id);
  if (group) group.service = service;
  if (id === state.selected && state.detail) state.detail.service = service;
}

async function recoverService(action) {
  const id = state.selected;
  const button = action === 'recover' ? $('recover-connection') : $('open-snowluma');
  if (!id || button.disabled) return;
  state.servicePending.set(id, action); renderRunStatus();
  try {
    const result = await api(`${groupUrl(id)}/${action}`, { method: 'POST', body: {} });
    rememberService(id, result);
    if (id === state.selected) notice(result.message || (result.ok ? 'SnowLuma 服务已就绪。' : result.started ? '已请求打开 SnowLuma，请在启动窗口查看运行情况。' : 'SnowLuma 尚未连接，请查看下方原因。'), result.ok === false && !result.started);
    await refreshState();
  } catch (error) {
    rememberService(id, error.response);
    if (id === state.selected) notice(error.message, true);
  } finally { state.servicePending.delete(id); renderRunStatus(); }
}

function acceptRunStates() {
  for (const [id, pending] of state.runPending) {
    if (pending.submitting) continue;
    const group = state.groups.find(item => item.id === id);
    const runtime = group?.runtime;
    const acknowledged = !pending.requestId || runtime?.requestId === pending.requestId;
    const applied = pending.action === 'stop' ? group && !group.running && !group.starting : pending.action === 'start'
      ? group?.running && runtime && !runtime.paused
      : group?.running && runtime && acknowledged && runtime.paused === (pending.action === 'pause');
    if (applied) {
      state.runPending.delete(id);
      if (state.selected === id) notice({ start: 'Pi 已启动。', pause: 'Pi 已暂停，对话消息会继续保存。', resume: 'Pi 已恢复运行。', stop: 'Pi 已停止，现在可以调整对话归属。' }[pending.action]);
    } else if (Date.now() - pending.startedAt >= 15_000) {
      state.runPending.delete(id);
      if (state.selected === id) notice(pending.action === 'stop' ? 'Pi 尚未停止，请检查当前终端或稍后刷新状态。' : group?.running
        ? '尚未收到操作完成状态。若本对话组使用的是旧终端，请执行 /reload 后重试。'
        : 'Pi 尚未启动成功，请检查本对话组运行状态或终端提示。', true);
    }
  }
  renderRunStatus();
}

function scheduleRunPoll() {
  if (state.runPoll || !state.runPending.size) return;
  state.runPoll = setTimeout(async () => {
    state.runPoll = null;
    await refreshState();
    acceptRunStates();
    scheduleRunPoll();
  }, 1000);
}

async function controlRun(requestedAction) {
  const id = state.selected;
  const action = typeof requestedAction === 'string' ? requestedAction : $('run-action').dataset.action;
  if (!id || (action === 'stop' ? $('stop-run').disabled : $('run-action').disabled)) return;
  const pending = { action, startedAt: Date.now(), requestId: null, submitting: true };
  state.runPending.set(id, pending);
  renderRunStatus();
  notice({ start: '正在启动本对话组 Pi…', pause: '正在请求暂停…', resume: '正在请求恢复运行…', stop: '正在正常关闭本对话组 Pi…' }[action]);
  try {
    const result = await api(`${groupUrl(id)}/${action}`, { method: 'POST', body: {} });
    rememberService(id, result);
    pending.requestId = result.requestId || null;
    pending.startedAt = Date.now(); pending.submitting = false;
    if (state.selected === id) notice({ start: '已请求启动，正在等待 Pi 就绪…', pause: '暂停请求已提交，正在等待 Pi 确认…', resume: '恢复请求已提交，正在等待 Pi 确认…', stop: '停止请求已提交，正在等待会话退出…' }[action]);
    await refreshState();
    acceptRunStates();
    scheduleRunPoll();
  } catch (error) {
    rememberService(id, error.response);
    state.runPending.delete(id);
    if (state.selected === id) notice(error.message, true);
    renderRunStatus();
  }
}

async function refreshState(initial = false) {
  if (state.loadingState) return;
  state.loadingState = true;
  try {
    const next = await api('/api/state');
    state.csrfToken = next.csrfToken;
    state.groups = next.groups;
    for (const group of next.groups) if (group.service) state.serviceCache.set(group.id, group.service);
    state.defaultWsUrl = next.defaultWsUrl || state.defaultWsUrl;
    $('root-path').textContent = next.root;
    $('root-path').title = next.root;
    renderGroups();
    acceptRunStates();
    if (initial) {
      let remembered;
      try { remembered = localStorage.getItem('piq:selected-group'); } catch { /* Storage is optional. */ }
      const id = next.groups.find(group => group.id === remembered)?.id || next.groups[0]?.id;
      if (id) await selectGroup(id, true);
      else { $('welcome').hidden = false; $('group-workspace').hidden = true; }
    }
    const current = next.groups.find(group => group.id === state.selected);
    if (!initial && state.detail && current?.name && Array.isArray(current.conversations)) {
      const currentMembership = JSON.stringify({ name: current.name, conversations: current.conversations });
      const loadedMembership = JSON.stringify({ name: state.detail.config.name, conversations: state.detail.config.conversations });
      if (currentMembership !== loadedMembership) {
        state.membershipOutdated = true;
        if (!membershipDirty() && !configDirty() && !state.busy && !state.configLoading) await reloadConfiguration(true);
        else updateMembershipState();
      }
    }
    if (!initial && state.modelLoaded && (state.tab === 'model' || (state.modelPendingRequestId && !state.modelAwaitTimedOut))) await refreshModelRuntime();
  } catch (error) {
    if (initial) { $('group-list').textContent = '读取对话组目录失败'; $('welcome').hidden = true; }
    notice(error.message, true);
  } finally { state.loadingState = false; }
}

async function selectGroup(id, force = false) {
  if (state.selected === id && state.detail) return;
  if (!force && !mayDiscard()) return;
  const sequence = ++state.detailSequence;
  state.documentSequence++; state.logSequence++; state.modelSequence++; state.slangSequence++;
  state.slangEntries = []; state.slangConversations = []; state.slangLoading = false;
  $('slang-search').value = ''; $('slang-status').value = 'all'; $('slang-error').hidden = true; renderSlang();
  $('group-menu').open = false;
  state.selected = id; state.detail = null; state.documentLoaded = false; state.modelLoaded = false;
  state.membershipLoaded = false; state.membershipOutdated = false; state.configLoading = false; state.logConversation = '';
  state.modelRuntime = null; state.modelPendingRequestId = null; state.modelAwaitTimedOut = false;
  $('model-runtime').textContent = '正在读取当前会话…'; $('model-runtime').classList.remove('error');
  $('welcome').hidden = true; $('group-workspace').hidden = false;
  $('group-title').textContent = state.groups.find(group => group.id === id)?.name || id;
  $('group-path').textContent = state.groups.find(group => group.id === id)?.path || '';
  $('document-content').value = ''; $('document-content').disabled = true;
  $('open-terminal').disabled = true;
  $('run-action').disabled = true;
  document.querySelectorAll('#connection-form input').forEach(input => { input.disabled = true; });
  $('save-config').disabled = true;
  $('model-choice').disabled = true; $('thinking-choice').disabled = true; $('save-model').disabled = true;
  renderGroups(); updateDocumentState(); notice('');
  try { localStorage.setItem('piq:selected-group', id); } catch { /* The current selection still works without storage. */ }
  try {
    const detail = await api(groupUrl(id));
    if (sequence !== state.detailSequence) return;
    state.detail = detail;
    const summary = state.groups.find(group => group.id === id);
    if (summary) Object.assign(summary, { name: detail.config.name, conversations: detail.config.conversations, running: detail.running, starting: detail.starting, pid: detail.pid, runtime: detail.runtime, service: detail.service });
    if (detail.service) state.serviceCache.set(id, detail.service);
    $('group-path').textContent = detail.path;
    renderRunStatus();
    setConfig(detail);
    setLogOptions(detail.logs || {});
    await loadDocument(state.document, true);
    if (state.tab === 'messages') await loadLog();
    if (state.tab === 'slang') await loadSlang();
    if (state.tab === 'model') await loadModel();
  } catch (error) {
    if (sequence === state.detailSequence) { notice(error.message, true); $('document-state').textContent = '读取失败'; }
  }
}

function setConfig(detail) {
  const config = detail.config;
  $('ws-url').value = config.wsUrl; $('token-env').value = config.accessTokenEnv;
  $('quiet-ms').value = config.quietMs; $('max-wait-ms').value = config.maxWaitMs; $('min-interval-ms').value = config.minIntervalMs;
  document.querySelectorAll('#connection-form input').forEach(input => { input.disabled = false; });
  for (const key of permissionKeys) $('permission-' + key).checked = config.permissions?.[key] !== false;
  state.configRevision = detail.configRevision || '';
  state.configText = JSON.stringify(connectionFields());
  $('group-name').value = config.name;
  $('conversation-rows').replaceChildren();
  for (const conversation of config.conversations) addConversationRow('conversation-rows', conversation);
  state.membershipSaved = JSON.stringify(membershipValue()); state.membershipLoaded = true;
  state.membershipOutdated = false;
  const credential = detail.credential || {};
  $('credential-status').textContent = credential.available ? '凭据已就绪' : '等待本地凭据';
  $('credential-status').classList.toggle('available', !!credential.available);
  $('credential-source').textContent = credential.source || '填写变量名，凭据由本地服务读取。';
  updateConfigState();
  updateMembershipState();
}

async function reloadConfiguration(automatic = false) {
  const id = state.selected, sequence = state.detailSequence;
  if (!id || !state.detail || state.configLoading || state.busy) return;
  if (!automatic && (membershipDirty() || configDirty()) && !window.confirm('重新读取会丢弃尚未保存的对话归属和连接设置。继续吗？')) return;
  state.configLoading = true; updateMembershipState();
  document.querySelectorAll('#connection-form input').forEach(input => { input.disabled = true; });
  updateConfigState();
  try {
    const detail = await api(groupUrl(id));
    if (id !== state.selected || sequence !== state.detailSequence) return;
    state.detail = detail;
    const summary = state.groups.find(item => item.id === id);
    if (summary) Object.assign(summary, { name: detail.config.name, conversations: detail.config.conversations, running: detail.running,
      starting: detail.starting, pid: detail.pid, runtime: detail.runtime, service: detail.service });
    setConfig(detail); setLogOptions(detail.logs || {}); renderGroups();
    if (!automatic) notice('已重新读取对话组配置。');
  } catch (error) { if (id === state.selected && sequence === state.detailSequence) notice(error.message, true); }
  finally {
    if (id === state.selected && sequence === state.detailSequence) {
      state.configLoading = false;
      if (state.detail) document.querySelectorAll('#connection-form input').forEach(input => { input.disabled = false; });
      updateMembershipState(); updateConfigState();
    }
  }
}

const documentHints = {
  'ROOT_AGENTS.md': '所有对话组共用的行为约定。根目录 AGENTS.md 由 Pi 原生加载，运行中的会话可用 /reload 更新。',
  'AGENTS.md': 'Pi 自动加载的本对话组约定，适合放始终需要遵循的说明。',
  'PERSONA.md': '在这里写下本对话组的人设、语气和偏好。',
  'MEMORY.md': '本对话组的长期记忆，也可以交给 Agent 自行整理。',
};

async function loadDocument(filename, force = false) {
  if (!state.detail) return;
  if (!force && filename === state.document && state.documentLoaded) return;
  if (!force && documentDirty() && !window.confirm('当前文档尚未保存，切换后将丢弃这些修改。继续吗？')) return;
  const sequence = ++state.documentSequence;
  const id = state.selected;
  state.document = filename; state.documentLoaded = false;
  $('document-content').value = ''; $('document-content').disabled = true;
  $('editor-label').textContent = `${documentLabel(filename)} 内容`;
  $('document-hint').textContent = documentHints[filename] || '用 Markdown 管理本对话组资料。';
  $('document-content').placeholder = filename === 'MEMORY.md' ? '# 记忆\n\n在这里记录需要长期保留的事情…' : '在这里写下本对话组的约定…';
  document.querySelectorAll('[data-document]').forEach(button => {
    const active = button.dataset.document === filename;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  updateDocumentState();
  try {
    const result = await api(documentUrl(filename, id));
    if (sequence !== state.documentSequence || id !== state.selected) return;
    state.documentText = result.content; state.documentRevision = result.revision;
    $('document-content').value = result.content; $('document-content').disabled = false;
    state.documentLoaded = true; updateDocumentState();
  } catch (error) {
    if (sequence === state.documentSequence) { notice(error.message, true); $('document-state').textContent = '读取失败'; }
  }
}

async function saveDocument() {
  if (!documentDirty() || state.busy) return;
  const id = state.selected, filename = state.document, content = $('document-content').value;
  state.busy = true; updateDocumentState();
  try {
    const result = await api(documentUrl(filename, id), { method: 'PUT', body: { content, revision: state.documentRevision } });
    if (id === state.selected && filename === state.document) {
      state.documentText = content; state.documentRevision = result.revision; notice(`${documentLabel(filename)} 已保存。`);
    }
  } catch (error) { notice(error.message, true); }
  finally { state.busy = false; updateDocumentState(true); updateConfigState(); updateMembershipState(); }
}

async function saveConfig(event) {
  event.preventDefault();
  if (!configDirty() || state.busy || !$('connection-form').reportValidity()) return;
  const config = configValue();
  if (config.quietMs > config.maxWaitMs) { notice('最长等待不能小于静默等待。', true); return; }
  const id = state.selected, sequence = state.detailSequence;
  state.busy = true; updateConfigState();
  try {
    const result = await api(`${groupUrl(id)}/config`, { method: 'PUT', body: { config, revision: state.configRevision } });
    if (id === state.selected && sequence === state.detailSequence) {
      state.detail.config = result.config;
      state.configText = JSON.stringify({ wsUrl: config.wsUrl, accessTokenEnv: config.accessTokenEnv,
        quietMs: config.quietMs, maxWaitMs: config.maxWaitMs, minIntervalMs: config.minIntervalMs, permissions: config.permissions });
      state.configRevision = result.revision; state.detail.configRevision = result.revision;
      notice('设置已保存。功能权限立即生效；连接与聚合设置在重启或 /reload 后生效。');
    }
  } catch (error) {
    if (id === state.selected && sequence === state.detailSequence) {
      if (error.status === 409 && /配置.*(其他位置|保存期间|已变更)/.test(error.message)) state.membershipOutdated = true;
      notice(error.message, true);
    }
  }
  finally { state.busy = false; updateConfigState(); updateDocumentState(); updateMembershipState(); }
}

async function saveMembership(event) {
  event.preventDefault();
  if (!membershipDirty() || membershipLocked() || state.busy || !$('membership-form').reportValidity()) return;
  const id = state.selected, sequence = state.detailSequence;
  let chosen;
  try {
    chosen = membershipValue();
    chosen.conversations = validateConversations(chosen.conversations);
    if (!chosen.name) throw new Error('请填写对话组名称。');
  } catch (error) { notice(error.message, true); return; }
  const config = { ...state.detail.config, ...chosen };
  state.busy = true; updateMembershipState(); updateConfigState();
  try {
    const result = await api(`${groupUrl(id)}/config`, { method: 'PUT', body: { config, revision: state.configRevision } });
    if (id === state.selected && sequence === state.detailSequence) {
      state.detail.config = result.config;
      state.configRevision = result.revision; state.detail.configRevision = result.revision;
      $('group-name').value = result.config.name;
      $('conversation-rows').replaceChildren();
      for (const conversation of result.config.conversations) addConversationRow('conversation-rows', conversation);
      state.membershipSaved = JSON.stringify(membershipValue());
      state.membershipOutdated = false;
      const group = state.groups.find(item => item.id === id);
      if (group) Object.assign(group, { name: result.config.name, conversations: result.config.conversations });
      renderGroups(); setLogOptions(state.detail.logs || {});
      notice('对话组已保存，文档与会话由组内对话共同使用。');
    }
  } catch (error) {
    if (id === state.selected && sequence === state.detailSequence) {
      if (error.status === 409 && /配置.*(其他位置|保存期间|已变更)/.test(error.message)) state.membershipOutdated = true;
      notice(error.message, true);
    }
  }
  finally { state.busy = false; updateMembershipState(); updateConfigState(); updateDocumentState(); }
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  });
  for (const name of ['conversations', 'documents', 'messages', 'slang', 'model', 'connection']) $(`panel-${name}`).hidden = name !== tab;
  if (tab === 'messages' && state.detail) void refreshLogs();
  if (tab === 'slang' && state.detail) void loadSlang();
  if (tab === 'model' && state.detail && !state.modelLoaded) void loadModel();
  else if (tab === 'model' && state.modelLoaded) void refreshModelRuntime();
}

const thinkingLabels = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
const inheritedThinkingLevels = Object.keys(thinkingLabels);

function updateModelState() {
  const dirty = modelDirty();
  $('model-state').classList.toggle('dirty', dirty);
  $('model-state').textContent = !state.modelLoaded ? '正在读取…' : dirty ? '有未保存的修改' : '已保存';
  $('save-model').disabled = !state.modelLoaded || !dirty || state.busy;
}

function currentModelDescription(runtime) {
  if (!runtime) return '';
  const model = [runtime.provider, runtime.model].filter(Boolean).join(' / ');
  const thinking = runtime.thinkingLevel ? `思考：${thinkingLabels[runtime.thinkingLevel] || runtime.thinkingLevel} (${runtime.thinkingLevel})` : '';
  return [model, thinking].filter(Boolean).join(' · ');
}

function renderModelRuntime() {
  const runtime = state.modelRuntime;
  const description = currentModelDescription(runtime);
  const line = $('model-runtime');
  line.classList.toggle('error', !state.modelPendingRequestId && runtime?.status === 'error');
  if (state.modelPendingRequestId) {
    line.textContent = state.modelAwaitTimedOut
      ? '已保存，等待 Pi 应用。若会话早于本次更新启动，请在终端执行 /reload。'
      : `正在应用到当前会话…${description ? ` 当前：${description}` : ''}`;
  } else if (runtime?.status === 'error') {
    line.textContent = `当前会话应用失败：${runtime.error || '请在 Pi 终端查看详情。'}${description ? ` 当前：${description}` : ''}`;
  } else if (runtime && description) {
    line.textContent = `当前会话：${description}`;
  } else {
    line.textContent = state.groups.find(group => group.id === state.selected)?.running
      ? '尚未收到当前会话状态；可在 Pi 终端执行 /reload。'
      : 'Pi 未运行，保存的选择将在下次启动时应用。';
  }
}

function acceptModelRuntime(runtime) {
  state.modelRuntime = runtime || null;
  const requestId = state.modelPendingRequestId;
  if (requestId && runtime?.requestId === requestId && ['applied', 'error'].includes(runtime.status)) {
    state.modelPendingRequestId = null; state.modelAwaitTimedOut = false;
    if (runtime.status === 'applied') notice(`已应用到当前会话${currentModelDescription(runtime) ? `：${currentModelDescription(runtime)}` : '。'}`);
    else notice(`选择已保存，但当前会话应用失败：${runtime.error || '请在 Pi 终端查看详情。'}`, true);
  } else if (requestId && !state.modelAwaitTimedOut && Date.now() - state.modelAwaitStarted >= 15_000) {
    state.modelAwaitTimedOut = true;
    notice('已保存，等待 Pi 应用；如会话早于本次更新启动，请在终端执行 /reload。');
  }
  renderModelRuntime();
}

async function refreshModelRuntime() {
  if (!state.selected || !state.modelLoaded || state.modelRuntimeLoading) return;
  const id = state.selected, sequence = state.modelSequence;
  state.modelRuntimeLoading = true;
  try {
    const preference = await api(`${groupUrl(id)}/model`);
    if (id === state.selected && sequence === state.modelSequence) acceptModelRuntime(preference.runtime);
  } catch (error) {
    if (id === state.selected && sequence === state.modelSequence) {
      $('model-runtime').textContent = `读取当前会话失败：${error.message}`;
      $('model-runtime').classList.add('error');
      if (state.modelPendingRequestId && !state.modelAwaitTimedOut && Date.now() - state.modelAwaitStarted >= 15_000) {
        state.modelAwaitTimedOut = true;
        notice('选择已保存，暂未收到 Pi 的应用结果。恢复连接后，可在模型页查看当前状态。', true);
      }
    }
  } finally { state.modelRuntimeLoading = false; }
}

function updateThinking(preferred = $('thinking-choice').value) {
  const choice = $('model-choice').value;
  const chosen = state.models?.find(model => JSON.stringify([model.provider, model.id]) === choice);
  const select = $('thinking-choice');
  select.replaceChildren();
  const inherited = document.createElement('option'); inherited.value = ''; inherited.textContent = '沿用 Pi'; select.append(inherited);
  const levels = choice ? chosen?.thinkingLevels || [] : inheritedThinkingLevels;
  for (const level of levels) {
    const option = document.createElement('option'); option.value = level; option.textContent = `${thinkingLabels[level] || level} · ${level}`; select.append(option);
  }
  select.value = [...select.options].some(option => option.value === preferred) ? preferred : '';
  select.disabled = !levels.length;
}

async function loadModel() {
  const sequence = ++state.modelSequence, id = state.selected;
  $('model-error').hidden = true; $('model-state').textContent = '正在读取…';
  try {
    const [catalog, preference] = await Promise.all([
      state.models ? Promise.resolve({ models: state.models, error: state.modelCatalogError })
        : api('/api/models').catch(error => ({ models: [], error: error.message })),
      api(`${groupUrl(id)}/model`),
    ]);
    if (id !== state.selected || sequence !== state.modelSequence) return;
    state.models = catalog.models || [];
    state.modelCatalogError = catalog.error || '';
    const select = $('model-choice'); select.replaceChildren();
    const inherited = document.createElement('option'); inherited.value = ''; inherited.textContent = '沿用 Pi / 当前会话'; select.append(inherited);
    for (const model of state.models) {
      const option = document.createElement('option'); option.value = JSON.stringify([model.provider, model.id]);
      option.textContent = `${model.provider} / ${model.name || model.id}${model.name && model.name !== model.id ? ` (${model.id})` : ''}`;
      select.append(option);
    }
    const selected = preference.provider && preference.model ? JSON.stringify([preference.provider, preference.model]) : '';
    if (selected && ![...select.options].some(option => option.value === selected)) {
      const option = document.createElement('option'); option.value = selected; option.textContent = `${preference.provider} / ${preference.model}（当前不可用）`; select.append(option);
    }
    select.value = selected; select.disabled = false;
    updateThinking(preference.thinkingLevel || '');
    // Preserve an unavailable saved strength so merely opening the page does not alter it.
    if (preference.thinkingLevel && !$('thinking-choice').value) {
      const option = document.createElement('option'); option.value = preference.thinkingLevel; option.textContent = `${preference.thinkingLevel}（已保存）`; $('thinking-choice').append(option); $('thinking-choice').value = preference.thinkingLevel;
    }
    state.modelRevision = preference.revision;
    state.modelSaved = JSON.stringify(modelValue()); state.modelLoaded = true;
    acceptModelRuntime(preference.runtime);
    updateModelState();
    if (catalog.error || !state.models.length) {
      $('model-error').textContent = catalog.error || 'Pi 暂无可用模型。可沿用当前会话，或在 Pi 中配置模型和认证后刷新页面。';
      $('model-error').hidden = false;
    }
  } catch (error) {
    if (id === state.selected && sequence === state.modelSequence) {
      $('model-error').textContent = error.message; $('model-error').hidden = false; $('model-state').textContent = '读取失败';
    }
  }
}

async function saveModel(event) {
  event.preventDefault();
  if (!modelDirty() || state.busy) return;
  const id = state.selected, preference = modelValue();
  state.busy = true; updateModelState();
  try {
    const result = await api(`${groupUrl(id)}/model`, { method: 'PUT', body: { ...preference, revision: state.modelRevision } });
    if (id === state.selected) {
      state.modelSaved = JSON.stringify(preference); state.modelRevision = result.revision;
      state.modelPendingRequestId = result.requestId || null;
      state.modelAwaitStarted = Date.now(); state.modelAwaitTimedOut = false;
      if (result.applyError) notice(`选择已保存，当前会话暂未应用：${result.applyError}`, true);
      else if (result.requestId) notice('已保存，正在应用到当前会话…');
      else notice('模型选择已保存，下次打开本对话组终端时应用。');
      acceptModelRuntime(result.runtime);
      if (result.requestId) void refreshModelRuntime();
    }
  } catch (error) { notice(error.message, true); }
  finally { state.busy = false; updateModelState(); updateConfigState(); updateDocumentState(); updateMembershipState(); }
}

function setLogOptions(logs) {
  const select = $('log-conversation');
  const conversations = new Map((state.detail?.config.conversations || []).map(conversation => [conversationKey(conversation), conversation]));
  for (const key of Object.keys(logs)) {
    const conversation = conversationFromKey(key);
    if (conversation && !conversations.has(key)) conversations.set(key, conversation);
  }
  select.replaceChildren();
  for (const [key, conversation] of conversations) {
    const option = document.createElement('option'); option.value = key; option.textContent = logConversationLabel(key); select.append(option);
  }
  if (!conversations.size) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无对话'; select.append(option); }
  select.disabled = !conversations.size;
  const preferred = conversations.has(state.logConversation) ? state.logConversation : [...conversations.keys()].find(key => logs[key]?.length) || [...conversations.keys()][0] || '';
  select.value = preferred; state.logConversation = preferred;
  setLogDates(logs[preferred] || []);
}

function setLogDates(logs) {
  const select = $('log-date');
  const previous = select.value;
  select.replaceChildren();
  const sorted = [...logs].sort().reverse();
  for (const filename of sorted) {
    const option = document.createElement('option'); option.value = filename; option.textContent = filename.replace(/\.jsonl$/, ''); select.append(option);
  }
  if (!sorted.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无记录'; select.append(option); }
  select.disabled = !sorted.length;
  select.value = sorted.includes(previous) ? previous : sorted[0] || '';
}

async function refreshLogs() {
  const id = state.selected;
  if (!id) return;
  $('refresh-logs').disabled = true;
  try {
    const detail = await api(groupUrl(id));
    if (id !== state.selected || !state.detail) return;
    state.detail.logs = detail.logs;
    setLogOptions(detail.logs || {});
    await loadLog();
  } catch (error) { notice(error.message, true); }
  finally { $('refresh-logs').disabled = false; }
}

function parseMessages(content, expectedConversation) {
  if (!content) return [];
  if (!content.endsWith('\n')) throw new Error('JSONL 日志末尾记录不完整，请刷新或检查文件。');
  return content.slice(0, -1).split(/\r?\n/).map((line, index) => {
    try {
      const record = JSON.parse(line);
      if (!record || record.v !== 2 || !Number.isSafeInteger(record.seq) || record.seq < 1
        || typeof record.receivedAt !== 'number' || !Number.isFinite(record.receivedAt) || record.receivedAt < 0
        || typeof record.rawText !== 'string'
        || !record.conversation || !['group', 'private', 'temporary'].includes(record.conversation.type)
        || typeof record.conversation.id !== 'string' || !/^[1-9]\d*$/.test(record.conversation.id)
        || !Number.isSafeInteger(Number(record.conversation.id))
        || (record.conversation.type === 'temporary' && (typeof record.conversation.sourceGroupId !== 'string'
          || !/^[1-9]\d*$/.test(record.conversation.sourceGroupId) || !Number.isSafeInteger(Number(record.conversation.sourceGroupId))))
        || conversationKey(record.conversation) !== expectedConversation || !Array.isArray(record.segments)) throw new Error();
      if (record.kind === 'poke') {
        const qqId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
        if (!['group', 'private'].includes(record.conversation.type)
          || typeof record.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.eventId)
          || !['notice', 'action'].includes(record.source)
          || !qqId(record.userId) || !qqId(record.selfId) || !qqId(record.targetId)
          || typeof record.time !== 'number' || !Number.isFinite(record.time) || record.time < 0
          || typeof record.sender !== 'string' || typeof record.outgoing !== 'boolean'
          || record.outgoing !== (record.userId === record.selfId)
          || (record.source === 'action' && !record.outgoing)
          || 'messageId' in record || 'messageSeq' in record
          || 'groupId' in record || 'sourceGroupId' in record || 'sourceGroupId' in record.conversation
          || record.segments.some(segment => !segment || typeof segment.type !== 'string' || !segment.type
            || !segment.data || typeof segment.data !== 'object' || Array.isArray(segment.data))) throw new Error();
      } else if ((record.kind !== undefined && record.kind !== 'message') || typeof record.messageId !== 'string') throw new Error();
      return record;
    } catch { throw new Error(`JSONL 日志第 ${index + 1} 条记录无效，请检查文件。`); }
  });
}

function renderMessages(content, truncated) {
  const list = $('message-list'); list.replaceChildren();
  const records = parseMessages(content, state.logConversation);
  $('log-content').textContent = content;
  $('raw-log').hidden = !content;
  $('raw-log').open = !!content && !records.length;
  $('messages-empty').hidden = !!content;
  $('log-error').hidden = true;
  list.hidden = !records.length;
  $('log-note').textContent = truncated ? `显示末尾 ${records.length} 条完整记录` : records.length ? `${records.length} 条记录` : '';
  for (const record of records) {
    const poke = record.kind === 'poke';
    const article = document.createElement('article'); article.className = 'message-entry';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const source = document.createElement('span'); source.className = 'message-source';
    const known = state.detail.config.conversations.find(conversation => conversationKey(conversation) === conversationKey(record.conversation));
    source.textContent = conversationLabel(known || record.conversation);
    const sender = document.createElement('span'); sender.className = 'message-author'; sender.textContent = record.sender || record.userId || '未知发送人';
    const id = document.createElement('span'); id.textContent = poke ? '戳一戳' : record.messageId ? `#${record.messageId}` : '';
    const time = document.createElement('time'); time.className = 'message-time';
    const date = new Date(Number(record.time) * 1000);
    time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '';
    meta.append(source, sender);
    if (poke || record.outgoing) {
      const sent = document.createElement('span'); sent.className = 'message-direction';
      sent.textContent = poke ? record.source === 'action' ? '已发起' : '事件通知' : '已发送'; meta.append(sent);
    }
    meta.append(id, time);
    const text = document.createElement('div'); text.className = 'message-text';
    text.textContent = poke ? `${record.userId} 戳了 ${record.targetId}` : record.rawText || '（非文字消息）';
    article.append(meta, text);
    const attachments = !poke && Array.isArray(record.segments) ? record.segments.filter(segment => segment?.type && segment.type !== 'text') : [];
    if (attachments.length) {
      const extra = document.createElement('div'); extra.className = 'message-attachments';
      const labels = { image: '图片', face: '表情', reply: '引用', at: '提及', file: '文件', record: '语音', video: '视频', forward: '转发' };
      extra.textContent = attachments.map(segment => labels[segment.type] || segment.type).join(' · ');
      article.append(extra);
    }
    list.append(article);
  }
}

async function loadLog() {
  const sequence = ++state.logSequence;
  const id = state.selected, filename = $('log-date').value, conversation = state.logConversation;
  if (!filename) { renderMessages('', false); return; }
  renderMessages('', false);
  $('messages-empty').hidden = true;
  $('log-note').textContent = '正在读取…';
  try {
    const result = await api(`${groupUrl(id)}/logs/${encodeURIComponent(conversation)}/${encodeURIComponent(filename)}`);
    if (sequence !== state.logSequence || id !== state.selected || conversation !== state.logConversation) return;
    renderMessages(result.content, result.truncated);
  } catch (error) {
    if (sequence === state.logSequence) {
      notice(error.message, true);
      $('log-note').textContent = '读取失败';
      $('messages-empty').hidden = true;
      $('log-error').textContent = error.message;
      $('log-error').hidden = false;
    }
  }
}

async function openTerminal() {
  if (!state.selected || $('open-terminal').disabled) return;
  const id = state.selected;
  state.terminalPending.add(id); renderRunStatus();
  try {
    const result = await api(`${groupUrl(id)}/open`, { method: 'POST', body: {} });
    rememberService(id, result);
    notice(result.message || (result.alreadyRunning ? '本对话组 Pi 已在运行，请切换到对应终端。' : '已请求打开终端，将继续本对话组最近的会话。'));
    await refreshState();
  } catch (error) { rememberService(id, error.response); notice(error.message, true); }
  finally { state.terminalPending.delete(id); renderRunStatus(); }
}

function showAdd() {
  $('new-group-name').value = ''; $('new-group-id').value = ''; $('new-ws-url').value = state.detail?.config.wsUrl || state.defaultWsUrl;
  $('new-conversation-rows').replaceChildren(); addConversationRow('new-conversation-rows');
  $('add-error').hidden = true; $('add-dialog').showModal(); $('new-group-name').focus();
}

async function addGroup(event) {
  event.preventDefault();
  if (!$('add-form').reportValidity()) return;
  $('confirm-add').disabled = true; $('add-error').hidden = true;
  try {
    const body = { name: $('new-group-name').value.trim(), conversations: validateConversations(readConversationRows('new-conversation-rows')), wsUrl: $('new-ws-url').value.trim() };
    if ($('new-group-id').value.trim()) body.id = $('new-group-id').value.trim();
    const result = await api('/api/groups', { method: 'POST', body });
    $('add-dialog').close();
    await refreshState();
    if (mayDiscard()) await selectGroup(result.id, true);
    notice(`对话组“${body.name}”已创建。`);
  } catch (error) { $('add-error').textContent = error.message; $('add-error').hidden = false; }
  finally { $('confirm-add').disabled = false; }
}

$('rename-group').addEventListener('click', () => manageGroup('rename'));
$('copy-group').addEventListener('click', () => manageGroup('copy'));
$('delete-group').addEventListener('click', () => manageGroup('delete'));
$('refresh-slang').addEventListener('click', loadSlang);
$('slang-search').addEventListener('input', renderSlang);
$('slang-status').addEventListener('change', renderSlang);

$('document-content').addEventListener('input', () => updateDocumentState());
$('save-document').addEventListener('click', saveDocument);
$('connection-form').addEventListener('input', updateConfigState);
$('connection-form').addEventListener('submit', saveConfig);
$('membership-form').addEventListener('input', updateMembershipState);
$('membership-form').addEventListener('submit', saveMembership);
$('reload-config').addEventListener('click', () => reloadConfiguration());
$('add-conversation').addEventListener('click', () => addConversationRow('conversation-rows'));
$('add-new-conversation').addEventListener('click', () => addConversationRow('new-conversation-rows'));
$('model-form').addEventListener('submit', saveModel);
$('model-choice').addEventListener('change', () => { updateThinking(); updateModelState(); });
$('thinking-choice').addEventListener('change', updateModelState);
$('open-terminal').addEventListener('click', openTerminal);
$('run-action').addEventListener('click', controlRun);
$('stop-run').addEventListener('click', () => controlRun('stop'));
$('recover-connection').addEventListener('click', () => recoverService('recover'));
$('open-snowluma').addEventListener('click', () => recoverService('snowluma'));
$('refresh-logs').addEventListener('click', refreshLogs);
$('log-date').addEventListener('change', loadLog);
$('log-conversation').addEventListener('change', () => {
  state.logConversation = $('log-conversation').value;
  setLogDates(state.detail?.logs[state.logConversation] || []);
  void loadLog();
});
$('add-group').addEventListener('click', showAdd);
$('welcome-add').addEventListener('click', showAdd);
$('add-form').addEventListener('submit', addGroup);
$('close-add').addEventListener('click', () => $('add-dialog').close());
$('cancel-add').addEventListener('click', () => $('add-dialog').close());
document.querySelectorAll('[data-document]').forEach(button => button.addEventListener('click', () => loadDocument(button.dataset.document)));
const tabButtons = [...document.querySelectorAll('[data-tab]')];
tabButtons.forEach((button, index) => {
  button.addEventListener('click', () => setTab(button.dataset.tab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabButtons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
    tabButtons[next].focus(); setTab(tabButtons[next].dataset.tab);
  });
});
window.addEventListener('beforeunload', event => {
  if (documentDirty() || configDirty() || membershipDirty() || modelDirty()) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshState(); });
void refreshState(true);
state.poll = setInterval(() => { if (!document.hidden) void refreshState(); }, 5000);
