import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const entire = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const source = entire.slice(0, entire.indexOf("$('rename-group').addEventListener"));
class Element {
  tagName: string; children: Element[] = []; value = ''; hidden = false; disabled = false; open = false;
  checked = false; className = ''; href = ''; rel = ''; target = ''; dataset: Record<string, string> = {}; private ownText = '';
  classList = { toggle() {}, remove() {}, add() {} };
  constructor(tag = 'div') { this.tagName = tag; }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML rendering'); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; this.ownText = ''; }
  querySelectorAll() { return []; }
  setAttribute() {}
  contains() { return false; }
  reportValidity() { return true; }
}
function setup() {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  get('slang-status').value = 'all'; get('slang-error').hidden = true;
  const requests: Array<{ path: string; options: RequestInit }> = [];
  let answer: unknown = { entries: [], conversations: [] };
  let fetcher = async (_path: string, _options: RequestInit): Promise<unknown> => answer;
  const prompts: string[] = []; let confirmed = '';
  const context = createContext({
    URL, console, document: { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: () => [] },
    window: { prompt: (_message: string, _initial: string) => prompts.shift() ?? null, confirm: (message: string) => { confirmed = message; return true; } },
    localStorage: { setItem() {}, removeItem() {} },
    fetch: async (path: string, options: RequestInit) => { requests.push({ path, options }); const result = await fetcher(path, options); return { ok: true, json: async () => result }; },
  });
  runInContext(source, context);
  runInContext(`state.selected='one'; state.detail={config:{id:'one',name:'原组',conversations:[]},configRevision:'revision-1'}; state.configRevision='revision-1'; state.groups=[{id:'one',name:'原组',running:false}]; state.csrfToken='token';`, context);
  return { context, get, requests, prompts, confirmation: () => confirmed, setAnswer(value: unknown) { answer = value; }, setFetcher(value: typeof fetcher) { fetcher = value; }, run(code: string) { return runInContext(code, context); } };
}

test('slang filtering matches normalized terms, meaning and usage and keeps statuses distinct', () => {
  const page = setup();
  assert.equal(page.run(`filteredSlang([{term:'YYDS',meaning:'赞叹',usage:'夸人',status:'learned'},{term:'鱼',meaning:'昵称',usage:'熟人间',status:'candidate'}], 'ｙｙｄｓ', 'all').length`), 1);
  assert.equal(page.run(`filteredSlang([{term:'鱼',meaning:'昵称',usage:'熟人间',status:'candidate'}], '熟人', 'candidate').length`), 1);
  assert.equal(page.run(`filteredSlang([{term:'鱼',meaning:'昵称',usage:'熟人间',status:'candidate'}], '', 'learned').length`), 0);
});

test('slang rendering treats hostile fields as text and links only to credential-free HTTP(S)', () => {
  const page = setup();
  page.run(`state.slangEntries=[{term:'<img onerror=alert(1)>',status:'candidate',meaning:'<script>bad</script>',usage:'普通场景',example:'例句',cautions:'保持不确定',conversation:'group:123456',evidenceSeqs:[1,2],updatedAt:0,sources:[{title:'<svg onload=bad>',url:'https://example.com/source'},{title:'bad',url:'javascript:alert(1)'},{title:'bad',url:'https://user:password@example.com'}]}]; renderSlang();`);
  assert.match(page.get('slang-list').textContent, /<img onerror=alert\(1\)>/);
  assert.match(page.get('slang-list').textContent, /含义 · 模型推断/);
  assert.match(page.get('slang-list').textContent, /候选/);
  const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
  const nodes = flatten(page.get('slang-list'));
  assert.equal(nodes.filter(node => node.tagName === 'a').length, 1);
  assert.equal(nodes.find(node => node.tagName === 'a')!.rel, 'noopener noreferrer');
  assert.ok(!nodes.some(node => ['img', 'script', 'svg'].includes(node.tagName)));
  for (const url of ['javascript:alert(1)', 'file:///secret', 'data:text/html,bad', 'https://u:p@example.com']) assert.equal(page.run(`safeSlangSource(${JSON.stringify(url)})`), null);
});

test('stale slang responses cannot replace the currently selected group', async () => {
  const page = setup();
  const resolvers: Array<(value: unknown) => void> = [];
  page.setFetcher(() => new Promise(resolve => resolvers.push(resolve)));
  const first = page.run('loadSlang()');
  page.run(`state.selected='two'; state.detail={config:{id:'two',name:'第二组',conversations:[]}};`);
  const second = page.run('loadSlang()');
  resolvers[1]!({ entries: [{ term: '第二组词', status: 'candidate', evidenceSeqs: [] }], conversations: [] }); await second;
  resolvers[0]!({ entries: [{ term: '旧组词', status: 'learned', evidenceSeqs: [] }], conversations: [] }); await first;
  assert.equal(page.run('state.slangEntries[0].term'), '第二组词');
  assert.equal(page.get('refresh-slang').disabled, false);
});

test('group actions disable copying and deletion while running but permit renaming', async () => {
  const page = setup();
  page.run(`state.groups[0].running=true; renderGroupManagement();`);
  assert.equal(page.get('copy-group').disabled, true); assert.equal(page.get('delete-group').disabled, true); assert.equal(page.get('rename-group').disabled, false);
  await page.run(`manageGroup('delete')`);
  assert.equal(page.requests.length, 0);
  assert.match(page.get('notice').textContent, /先停止/);
  assert.equal(page.run(`validGroupName('  新名称  ')`), '新名称');
  assert.throws(() => page.run(`validGroupName('')`)); assert.throws(() => page.run(`validGroupName('x'.repeat(81))`));
});

test('rename uses the config revision without changing membership or another selected group', async () => {
  const page = setup(); page.prompts.push('新组名');
  page.run(`membershipDirty=()=>false; configDirty=()=>false; membershipValue=()=>({name:$('group-name').value,conversations:state.detail.config.conversations}); renderGroups=()=>{}; renderRunStatus=()=>{};`);
  page.setAnswer({ config: { id: 'one', name: '新组名', conversations: [] }, revision: 'revision-2' });
  await page.run(`manageGroup('rename')`);
  assert.equal(page.requests[0]!.path, '/api/groups/one/config');
  const body = JSON.parse(String(page.requests[0]!.options.body));
  assert.equal(body.revision, 'revision-1'); assert.equal(body.config.name, '新组名'); assert.deepEqual(body.config.conversations, []);
  assert.equal(page.run('state.configRevision'), 'revision-2'); assert.equal(page.run('state.detail.configRevision'), 'revision-2');
});

test('copy selects the empty-member result and deletion moves to recovery with a next-group selection', async () => {
  const page = setup(); page.prompts.push('测试副本');
  page.run(`renderGroups=()=>{}; renderRunStatus=()=>{}; refreshState=async()=>{}; mayDiscard=()=>true; selectGroup=async(id)=>{state.selected=id;};`);
  page.setAnswer({ id: 'copied', name: '测试副本', path: '/root/copied' });
  await page.run(`manageGroup('copy')`);
  assert.equal(page.requests[0]!.path, '/api/groups/one/copy'); assert.deepEqual(JSON.parse(String(page.requests[0]!.options.body)), { name: '测试副本' });
  assert.equal(page.run('state.selected'), 'copied'); assert.match(page.get('notice').textContent, /添加成员/);
  page.run(`state.selected='one'; state.detail={config:{id:'one',name:'原组',conversations:[]}}; state.groups=[{id:'one',running:false},{id:'two',running:false}];`);
  page.setAnswer({ deleted: true, id: 'one', recoveryPath: '/root/.trash/one' });
  await page.run(`manageGroup('delete')`);
  assert.equal(page.requests[1]!.options.method, 'DELETE'); assert.equal(page.run('state.selected'), 'two');
  assert.match(page.confirmation(), /原组/); assert.match(page.confirmation(), /可手动恢复/); assert.match(page.get('notice').textContent, /\.trash/);
});

test('a deleted final group returns to the welcome screen', async () => {
  const page = setup();
  page.run(`renderGroups=()=>{}; renderRunStatus=()=>{}; refreshState=async()=>{}; mayDiscard=()=>true;`);
  page.setAnswer({ deleted: true, id: 'one', recoveryPath: '/root/.trash/one' });
  await page.run(`manageGroup('delete')`);
  assert.equal(page.run('state.selected'), null); assert.equal(page.get('welcome').hidden, false); assert.equal(page.get('group-workspace').hidden, true);
});

test('permission controls default on and save through the existing revision without dropping other settings', async () => {
  const page = setup();
  page.run(`state.detail={config:{id:'one',name:'原组',conversations:[],wsUrl:'ws://127.0.0.1:3001/',accessTokenEnv:'TOKEN',quietMs:1500,maxWaitMs:10000,minIntervalMs:15000,slang:{enabled:true,webResearch:true}},configRevision:'revision-1'}; setConfig(state.detail);`);
  for (const key of ['commands','fileRead','fileWrite','qq','network','otherTools']) assert.equal(page.get('permission-' + key).checked, true, key);
  assert.equal(page.run('configDirty()'), false);
  page.run(`$('permission-network').checked=false;`);
  assert.equal(page.run('configDirty()'), true);
  const value = JSON.parse(page.run('JSON.stringify(configValue())'));
  assert.equal(value.permissions.network, false); assert.equal(value.permissions.commands, true);
  assert.deepEqual(value.conversations, []); assert.deepEqual(value.slang, { enabled: true, webResearch: true });
  page.setAnswer({config:value,revision:'revision-2'});
  await page.run('saveConfig({preventDefault(){}})');
  const body=JSON.parse(String(page.requests[0]!.options.body));
  assert.equal(body.revision,'revision-1'); assert.equal(body.config.permissions.network,false);
  assert.equal(page.run('configDirty()'), false); assert.equal(page.run('state.configRevision'), 'revision-2');
  page.run(`state.detail.config.permissions={fileRead:false,network:false};setConfig(state.detail);`);
  assert.equal(page.get('permission-fileRead').checked,false); assert.equal(page.get('permission-fileWrite').checked,true);
});
