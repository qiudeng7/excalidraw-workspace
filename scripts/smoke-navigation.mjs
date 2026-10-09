#!/usr/bin/env node
// 本地全新数据库的目录排序/最近位置验收；不连接生产，不打印测试凭证。
// node scripts/smoke-navigation.mjs http://localhost:3000
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = new URL(process.argv[2] ?? 'http://localhost:3000');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.protocol === 'http:', '仅允许本地回环 HTTP');
assert.ok(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, '仅提供本地 origin');
const report = message => console.log(`✓ ${message}`);
async function request(path, method = 'GET', data, cookie) {
  const response = await fetch(new URL(`/api${path}`, base), { method, headers: { Origin: base.origin, 'Content-Type': 'application/json', 'X-Requested-With': 'excalidraw-demo', ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(15000), redirect: 'error', ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${method} ${path}: HTTP ${response.status} 返回非 JSON：${text.slice(0, 200)}`); }
  return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
function expect(result, code, operation) { assert.equal(result.status, code, `${operation}: HTTP 状态不符`); return result.body; }
const nonce = randomUUID();
const account = name => ({ email: `${name}-${nonce}@example.test`, password: `Smoke-${randomUUID()}!` });
const credentials = [account('navigation-admin'), account('navigation-a'), account('navigation-b')];
const scene = { elements: [{ id: nonce, type: 'rectangle' }], appState: {}, files: {} };

async function run() {
  assert.equal(expect(await request('/bootstrap'), 200, 'bootstrap').needsSetup, true, '仅允许全新本地数据库');
  const users = [];
  for (let index = 0; index < credentials.length; index++) {
    const result = await request(index === 0 ? '/setup' : '/register', 'POST', credentials[index]);
    expect(result, 200, '创建本地测试账户'); assert.ok(result.cookie); users.push(result.cookie);
  }
  const [, alice, bob] = users;
  const first = expect(await request('/workspaces', 'GET', undefined, alice), 200, '空间列表').workspaces[0];
  const second = expect(await request('/workspaces', 'POST', { name: '第二空间' }, alice), 200, '新增空间').workspace;
  const bobSpace = expect(await request('/workspaces', 'GET', undefined, bob), 200, '另一用户空间').workspaces[0];
  const list = async (space = first.id, user = alice) => expect(await request(`/workspaces/${space}/canvases`, 'GET', undefined, user), 200, '画布目录');
  const nav = async (user = alice) => expect(await request('/navigation', 'GET', undefined, user), 200, '读取最近位置');
  const order = (space, ids, revision, user = alice) => request(`/workspaces/${space}/canvas-order`, 'PUT', { canvasIds: ids, catalogRevision: revision }, user);
  // 以下字段与服务端契约保持一致；所有测试使用各自读取到的版本。
  const create = async (space, name) => {
    const catalog = await list(space);
    return expect(await request(`/workspaces/${space}/canvases`, 'POST', { name, catalogRevision: catalog.catalogRevision }, alice), 200, '新增画布').canvas;
  };
  const firstCanvas = (await list()).canvases[0];
  const canvas2 = await create(first.id, '二');
  const canvas3 = await create(first.id, '三');
  const otherCanvas = await create(second.id, '其他空间');
  const bobCanvas = (await list(bobSpace.id, bob)).canvases[0];
  const originalNav = await nav();
  assert.equal(originalNav.revision, 0);
  assert.equal(originalNav.lastWorkspaceId, null); assert.equal(originalNav.lastCanvasId, null);
  assert.deepEqual(originalNav.workspaces, []);
  await request(`/canvases/${canvas2.id}`, 'GET', undefined, alice);
  assert.deepEqual(await nav(), originalNav, '普通GET不得更新最近位置');
  const initial = await list();
  assert.deepEqual(initial.canvases.map(c => c.id), [firstCanvas.id, canvas2.id, canvas3.id], '新画布追加末尾');
  assert.deepEqual(initial.canvases.map(c => c.position), [0, 1, 2]);
  expect(await request(`/canvases/${firstCanvas.id}`, 'PUT', { revision: 0, scene }, alice), 200, '保存场景');
  const reversed = initial.canvases.map(c => c.id).reverse();
  expect(await order(first.id, reversed, initial.catalogRevision), 200, '重排');
  const reordered = await list();
  assert.equal(reordered.catalogRevision, initial.catalogRevision + 1);
  assert.deepEqual(reordered.canvases.map(c => c.id), reversed);
  assert.equal(expect(await request(`/canvases/${firstCanvas.id}`, 'GET', undefined, alice), 200, '重排后场景').canvas.revision, 1);
  expect(await request(`/canvases/${firstCanvas.id}`, 'PUT', { revision: 1, scene }, alice), 200, '重排不冲突场景保存');
  report('确定顺序、追加、完整重排与场景 revision 独立');
  for (const invalid of [[canvas2.id, canvas2.id, firstCanvas.id], reversed.slice(1), [...reversed, otherCanvas.id], [otherCanvas.id, ...reversed.slice(1)], [bobCanvas.id, ...reversed.slice(1)]]) {
    const before = await list();
    const result = await order(first.id, invalid, before.catalogRevision);
    assert.ok([400, 404].includes(result.status), '非法完整排列必须拒绝');
    assert.deepEqual(await list(), before, '非法排列不能部分更新');
  }
  expect(await order(first.id, reversed, reordered.catalogRevision, bob), 404, '跨用户排序');
  const beforeConcurrent = await list();
  const races = await Promise.all([order(first.id, reversed, beforeConcurrent.catalogRevision), order(first.id, [...reversed].reverse(), beforeConcurrent.catalogRevision)]);
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
  const winnerIds = races[0].status === 200 ? reversed : [...reversed].reverse();
  assert.deepEqual((await list()).canvases.map(c => c.id), winnerIds, '失败CAS不能部分改序');
  report('非法排列、跨用户/空间拒绝、并发排序 CAS 原子性');
  const nav0 = await nav();
  expect(await request('/navigation', 'PUT', { canvasId: canvas2.id, revision: nav0.revision }, alice), 200, '记录首次打开');
  const nav1 = await nav();
  assert.equal(nav1.lastWorkspaceId, first.id); assert.equal(nav1.lastCanvasId, canvas2.id);
  assert.deepEqual(nav1.workspaces, [{ workspaceId: first.id, lastCanvasId: canvas2.id }]);
  const responses = await Promise.all([request('/navigation', 'PUT', { canvasId: canvas3.id, revision: nav1.revision }, alice), request('/navigation', 'PUT', { canvasId: otherCanvas.id, revision: nav1.revision }, alice)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  // 首个成功提交生效；失败请求不能改变另一空间的记忆。
  const afterRace = await nav();
  assert.equal(afterRace.revision, nav1.revision + 1);
  const expectedWinner = responses[0].status === 200 ? canvas3 : otherCanvas;
  assert.equal(afterRace.lastCanvasId, expectedWinner.id); assert.equal(afterRace.lastWorkspaceId, expectedWinner.workspaceId);
  const preferences = value => Object.fromEntries(value.workspaces.map(entry => [entry.workspaceId, entry.lastCanvasId]));
  assert.deepEqual(preferences(afterRace), responses[0].status === 200 ? { [first.id]: canvas3.id } : { [first.id]: canvas2.id, [second.id]: otherCanvas.id }, '失败导航CAS不能部分更新空间记忆');
  expect(await request('/navigation', 'PUT', { canvasId: bobCanvas.id, revision: afterRace.revision }, alice), 404, '跨用户最近位置');
  assert.deepEqual(await nav(), afterRace);
  assert.equal((await nav(bob)).revision, 0, '另一用户偏好隔离');
  report('最近位置独立版本、跨用户隔离和并发原子更新');
  expect(await request('/navigation', 'PUT', { canvasId: otherCanvas.id, revision: afterRace.revision }, alice), 200, '切换其他空间');
  const inSecond = await nav();
  expect(await request('/navigation', 'PUT', { canvasId: firstCanvas.id, revision: inSecond.revision }, alice), 200, '切回首空间');
  const inFirst = await nav();
  assert.deepEqual(preferences(inFirst), { [first.id]: firstCanvas.id, [second.id]: otherCanvas.id }, '各空间分别记忆');
  await request(`/canvases/${canvas2.id}`, 'GET', undefined, alice);
  expect(await request(`/canvases/${firstCanvas.id}`, 'PATCH', { name: '改名不改最近位置' }, alice), 200, '画布改名');
  assert.deepEqual(await nav(), inFirst, '读取与改名不能偷偷更新偏好');
  report('各空间最近画布独立记忆，读取和改名不写偏好');
  const beforeCreate = await list();
  const createRace = await Promise.all([
    request(`/workspaces/${first.id}/canvases`, 'POST', { name: '并发创建', catalogRevision: beforeCreate.catalogRevision }, alice),
    order(first.id, [...beforeCreate.canvases.map(c => c.id)].reverse(), beforeCreate.catalogRevision),
  ]);
  assert.deepEqual(createRace.map(r => r.status).sort(), [200, 409], '创建与排序同版本仅一方成功');
  const afterCreate = await list(); assert.equal(afterCreate.catalogRevision, beforeCreate.catalogRevision + 1);
  if (createRace[0].status === 200) assert.deepEqual(afterCreate.canvases.map(c => c.id), [...beforeCreate.canvases.map(c => c.id), createRace[0].body.canvas.id]);
  else assert.deepEqual(afterCreate.canvases.map(c => c.id), [...beforeCreate.canvases.map(c => c.id)].reverse());
  const target = await create(first.id, '并发删除');
  const beforeDelete = await list();
  const deletionRace = await Promise.all([
    request(`/canvases/${target.id}`, 'DELETE', { catalogRevision: beforeDelete.catalogRevision }, alice),
    order(first.id, [...beforeDelete.canvases.map(c => c.id)].reverse(), beforeDelete.catalogRevision),
  ]);
  assert.deepEqual(deletionRace.map(r => r.status).sort(), [200, 409], '删除与排序同版本仅一方成功');
  const afterDelete = await list(); assert.equal(afterDelete.catalogRevision, beforeDelete.catalogRevision + 1);
  assert.deepEqual(afterDelete.canvases.map(c => c.id), deletionRace[0].status === 200 ? beforeDelete.canvases.filter(c => c.id !== target.id).map(c => c.id) : [...beforeDelete.canvases.map(c => c.id)].reverse());
  expect(await request(`/workspaces/${first.id}/canvases`, 'POST', { name: '旧版本创建', catalogRevision: beforeDelete.catalogRevision }, alice), 409, '旧版本创建');
  expect(await request(`/canvases/${firstCanvas.id}`, 'DELETE', { catalogRevision: beforeDelete.catalogRevision }, alice), 409, '旧版本删除');
  assert.deepEqual(await list(), afterDelete, '旧版本不能改变目录');
  report('并发创建/删除与排序互斥，旧目录版本拒绝且无部分修改');
  const beforeRemovalNav = await nav();
  expect(await request('/navigation', 'PUT', { canvasId: otherCanvas.id, revision: beforeRemovalNav.revision }, alice), 200, '选择将删除的画布');
  const beforeRemoval = await nav();
  const otherCatalog = await list(second.id);
  expect(await request(`/canvases/${otherCanvas.id}`, 'DELETE', { catalogRevision: otherCatalog.catalogRevision }, alice), 200, '删除最近画布');
  const afterCanvasRemoval = await nav();
  assert.equal(afterCanvasRemoval.lastCanvasId, null); assert.equal(afterCanvasRemoval.lastWorkspaceId, second.id);
  assert.equal(preferences(afterCanvasRemoval)[second.id], null); assert.equal(afterCanvasRemoval.revision, beforeRemoval.revision);
  assert.deepEqual((await list(second.id)).canvases, [], '最后一张删后读取不得自动创建');
  expect(await request(`/workspaces/${second.id}`, 'DELETE', undefined, alice), 200, '删除最近空间');
  const afterWorkspaceRemoval = await nav();
  assert.equal(afterWorkspaceRemoval.lastWorkspaceId, null); assert.equal(afterWorkspaceRemoval.lastCanvasId, null);
  assert.equal(preferences(afterWorkspaceRemoval)[second.id], undefined);
  assert.equal(preferences(afterWorkspaceRemoval)[first.id], firstCanvas.id);
  assert.equal(afterWorkspaceRemoval.revision, beforeRemoval.revision, '删除FK清理不重置偏好版本');
  report('删除最近画布/空间的FK清理及空空间无自动创建');
}
try { await run(); } catch (error) { console.error(`验收失败：${error instanceof Error ? error.message : '未知错误'}`); process.exitCode = 1; }
