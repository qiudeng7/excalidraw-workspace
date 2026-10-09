#!/usr/bin/env node
// 本地 API 验收：prepare 后真正重启进程/容器，再用 verify 检查同一持久卷。
// node scripts/smoke-api.mjs prepare http://127.0.0.1:8787 /tmp/workspace-smoke.json
// node scripts/smoke-api.mjs verify  http://127.0.0.1:8787 /tmp/workspace-smoke.json
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const [phase, rawBase, rawState = '/tmp/excalidraw-api-smoke.json'] = process.argv.slice(2);
assert.ok(['prepare', 'verify'].includes(phase), '阶段必须是 prepare 或 verify');
const base = new URL(rawBase ?? 'http://127.0.0.1:8787');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), '仅允许回环地址，禁止写入线上数据');
assert.equal(base.protocol, 'http:', '本地验收仅允许 http');
assert.ok(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, '请提供不含凭证、路径或参数的本地 origin');
const stateFile = resolve(rawState);
assert.ok(stateFile.startsWith('/tmp/'), '敏感验收状态仅允许存入 /tmp');
const report = (text) => console.log(`✓ ${text}`);

async function request(path, method = 'GET', data, cookie, overrides = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: base.origin, 'X-Requested-With': 'excalidraw-demo', ...overrides };
  if (cookie) headers.Cookie = cookie;
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  const response = await fetch(new URL(`/api${path}`, base), { method, headers, redirect: 'error', signal: AbortSignal.timeout(15000), ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${method} ${path}: HTTP ${response.status} 返回非 JSON`); }
  const setCookie = response.headers.get('set-cookie');
  return { status: response.status, body, cookie: setCookie?.split(';')[0], setCookie, cacheControl: response.headers.get('cache-control') };
}
function status(result, expected, label) { assert.equal(result.status, expected, `${label}: HTTP 状态不符`); return result; }
async function login(user) { const result = status(await request('/login', 'POST', { email: user.email, password: user.password }), 200, '登录'); assert.ok(result.cookie); assert.equal(result.body.user.id, user.id); return result.cookie; }

async function verify(state) {
  assert.equal(state.origin, base.origin, '必须针对准备阶段的同一本地 origin');
  for (const user of [state.admin, state.alice, state.bob]) {
    const session = status(await request('/session', 'GET', undefined, user.cookie), 200, '重启后 session');
    assert.equal(session.body.user?.id, user.id, '重启后原 session 必须有效');
    user.cookie = await login(user);
  }
  const loaded = status(await request(`/canvases/${state.canvasId}`, 'GET', undefined, state.alice.cookie), 200, '重启后画布');
  assert.equal(loaded.body.canvas.revision, 1);
  assert.deepEqual(loaded.body.canvas.scene, state.scene);
  const library = status(await request('/library', 'GET', undefined, state.alice.cookie), 200, '重启后素材库');
  assert.equal(library.body.revision, 1); assert.deepEqual(library.body.items, state.items);
  assert.equal((await request('/bootstrap')).body.registrationEnabled, false, '注册设置必须持久化');
  status(await request(`/canvases/${state.canvasId}`, 'GET', undefined, state.bob.cookie), 404, '重启后用户隔离');
  report('重启后账户、原 session、图片画布、素材库、revision、注册设置和隔离保持');
  status(await request('/logout', 'POST', undefined, state.alice.cookie), 200, '退出');
  assert.equal((await request('/session', 'GET', undefined, state.alice.cookie)).body.user, null);
  status(await request('/workspaces', 'GET', undefined, state.alice.cookie), 401, '旧 session 不可访问');
  status(await request('/admin/settings', 'PATCH', { registrationEnabled: true }, state.admin.cookie), 200, '恢复开放注册');
  report('退出立即失效；测试管理员已重新开放本地注册');
}

async function prepare() {
  const bootstrap = status(await request('/bootstrap'), 200, '初始化状态');
  assert.equal(bootstrap.body.needsSetup, true, '准备阶段要求全新本地数据库；禁止修改已有管理员数据');
  const nonce = randomUUID();
  const makeUser = (name) => ({ email: `${name}-${nonce}@example.test`, password: `Smoke-${randomUUID()}!` });
  const state = { version: 1, origin: base.origin, admin: makeUser('admin'), alice: makeUser('alice'), bob: makeUser('bob') };
  status(await request('/register', 'POST', state.alice), 403, '管理员建立前禁止注册');
  for (const [key, route] of [['admin', '/setup'], ['alice', '/register'], ['bob', '/register']]) {
    const result = status(await request(route, 'POST', { ...state[key], role: 'admin' }), 200, '创建账户');
    assert.ok(result.cookie); assert.match(result.setCookie, /HttpOnly/i); assert.match(result.setCookie, /SameSite=Strict/i);
    Object.assign(state[key], { id: result.body.user.id, cookie: result.cookie });
    assert.equal(result.body.user.role, key === 'admin' ? 'admin' : 'user');
  }
  status(await request('/setup', 'POST', makeUser('second-admin')), 409, '禁止第二管理员初始化');
  report('首个管理员、两个普通账户、角色注入和重复初始化');
  const { admin, alice, bob } = state;
  const workspace = status(await request('/workspaces', 'GET', undefined, alice.cookie), 200, '工作空间').body.workspaces[0];
  assert.ok(workspace?.id);
  const canvas = status(await request(`/workspaces/${workspace.id}/canvases`, 'GET', undefined, alice.cookie), 200, '默认画布').body.canvases[0];
  assert.ok(canvas?.id); state.canvasId = canvas.id;
  for (const [path, method, data] of [[`/workspaces/${workspace.id}/canvases`, 'GET'], [`/canvases/${canvas.id}`, 'GET'], [`/workspaces/${workspace.id}`, 'DELETE'], [`/canvases/${canvas.id}`, 'PUT', { revision: 0, scene: {} }]]) {
    status(await request(path, method, data, bob.cookie), 404, '跨用户隔离');
  }
  status(await request('/workspaces'), 401, '匿名用户隔离');
  status(await request('/admin/settings', 'PATCH', { registrationEnabled: false }, alice.cookie), 403, '管理员权限');
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: null }, { 'X-Requested-With': null }]) {
    status(await request('/admin/settings', 'PATCH', { registrationEnabled: false }, admin.cookie, headers), 403, 'CSRF 校验');
  }
  report('归属检查、管理员权限和 CSRF 拒绝');
  const imageId = `image-${nonce}`;
  state.scene = { elements: [{ id: `element-${nonce}`, type: 'image', fileId: imageId, x: 0, y: 0, width: 1, height: 1 }], appState: { viewBackgroundColor: '#ffffff' }, files: { [imageId]: { id: imageId, mimeType: 'image/png', created: Date.now(), dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHYsAAAAASUVORK5CYII=' } } };
  const saves = await Promise.all([1, 2].map(() => request(`/canvases/${canvas.id}`, 'PUT', { revision: 0, scene: state.scene }, alice.cookie)));
  assert.deepEqual(saves.map(r => r.status).sort(), [200, 409], '画布同 revision 仅一次成功');
  const scene = status(await request(`/canvases/${canvas.id}`, 'GET', undefined, alice.cookie), 200, '读取图片画布').body.canvas;
  assert.equal(scene.revision, 1); assert.deepEqual(scene.scene, state.scene);
  state.items = [{ id: `library-${nonce}`, status: 'unpublished', elements: [{ id: nonce, type: 'rectangle', x: 0, y: 0, width: 20, height: 20 }], created: Date.now() }];
  const libraries = await Promise.all([1, 2].map(() => request('/library', 'PUT', { revision: 0, items: state.items }, alice.cookie)));
  assert.deepEqual(libraries.map(r => r.status).sort(), [200, 409], '素材库同 revision 仅一次成功');
  assert.deepEqual((await request('/library', 'GET', undefined, bob.cookie)).body, { revision: 0, items: [] });
  report('图片画布与素材库完整保存，并发 CAS 和个人隔离');
  const temporaryWorkspace = status(await request('/workspaces', 'POST', { name: '验收临时空间' }, alice.cookie), 200, '创建工作空间').body.workspace;
  const temporaryCanvas = status(await request(`/workspaces/${temporaryWorkspace.id}/canvases`, 'POST', { name: '验收临时画布' }, alice.cookie), 200, '创建画布').body.canvas;
  status(await request(`/canvases/${temporaryCanvas.id}`, 'PUT', { revision: 0, scene: state.scene }, alice.cookie), 200, '临时快照');
  status(await request(`/canvases/${temporaryCanvas.id}`, 'PATCH', { name: '重命名画布' }, alice.cookie), 200, '重命名画布');
  status(await request(`/workspaces/${temporaryWorkspace.id}`, 'PATCH', { name: '重命名空间' }, alice.cookie), 200, '重命名空间');
  status(await request(`/workspaces/${temporaryWorkspace.id}`, 'DELETE', undefined, alice.cookie), 200, '删除空间');
  status(await request(`/canvases/${temporaryCanvas.id}`, 'GET', undefined, alice.cookie), 404, '级联删除画布');
  assert.match((await request('/session', 'GET', undefined, alice.cookie)).cacheControl ?? '', /no-store/i, '账户数据禁止共享缓存');
  report('工作空间和画布创建、改名、级联删除与私有响应缓存限制');
  status(await request('/admin/settings', 'PATCH', { registrationEnabled: false }, admin.cookie), 200, '关闭注册');
  status(await request('/register', 'POST', makeUser('closed')), 403, '关闭后禁止注册');
  status(await request('/login', 'POST', { email: alice.email, password: 'wrong-password-123' }), 401, '错误密码');
  const extraCookie = await login(alice);
  status(await request('/logout', 'POST', undefined, extraCookie), 200, '退出');
  assert.equal((await request('/session', 'GET', undefined, extraCookie)).body.user, null);
  status(await request('/workspaces', 'GET', undefined, extraCookie), 401, '退出后访问');
  report('注册开关、错误密码、已有账户登录和 session 退出');
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 }); await chmod(stateFile, 0o600);
  console.log('准备完成。请真正重启服务或容器（保留持久卷），然后执行 verify。状态文件仅存本地 /tmp，包含测试凭证，验收结束后删除。');
}

try { if (phase === 'prepare') await prepare(); else await verify(JSON.parse(await readFile(stateFile, 'utf8'))); }
catch (error) { console.error(`验收失败：${error instanceof Error ? error.message : '未知错误'}`); process.exitCode = 1; }
