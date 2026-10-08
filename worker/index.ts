import type { CanvasScene, User } from '../shared/contracts';

export interface Env { DB: D1Database; DATA: R2Bucket; ASSETS: Fetcher }
const MAX_BODY = 20 * 1024 * 1024;
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const EMPTY_SCENE: CanvasScene = { elements: [], appState: {}, files: {} };
class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function hashPassword(password: string, salt = random()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return `pbkdf2-sha256$100000$${salt}$${hex(bits)}`;
}
async function verifyPassword(password: string, stored: string) {
  const candidate = await hashPassword(password, stored.split('$')[2]);
  if (candidate.length !== stored.length) return false;
  let difference = 0;
  for (let i = 0; i < candidate.length; i++) difference |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
  return difference === 0;
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.includes('application/json')) fail(415, 'JSON_REQUIRED', '请使用 JSON 请求');
  if (Number(req.headers.get('content-length')) > MAX_BODY) fail(413, 'TOO_LARGE', '单次保存不能超过 20 MB');
  const reader = req.body?.getReader();
  if (!reader) fail(400, 'INVALID_BODY', '请求内容为空');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader!.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader!.cancel(); fail(413, 'TOO_LARGE', '单次保存不能超过 20 MB'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const result: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!isObject(result)) throw Error(); return result; }
  catch { return fail(400, 'INVALID_BODY', '请求内容不是有效的 JSON 对象'); }
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function name(value: unknown, fallback?: string) {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) return fail(400, 'INVALID_NAME', '名称需为 1–100 个字符');
  return value.trim();
}
function credentials(data: Record<string, unknown>) {
  if (typeof data.email !== 'string' || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) fail(400, 'INVALID_EMAIL', '请输入有效邮箱');
  if (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 256) fail(400, 'INVALID_PASSWORD', '密码需为 12–256 个字符');
  return { email: (data.email as string).trim().toLowerCase(), password: data.password as string };
}
function cookie(req: Request, token: string, age = SESSION_SECONDS) {
  return `excalidraw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function sessionToken(req: Request) { return req.headers.get('cookie')?.match(/(?:^|;\s*)excalidraw_session=([a-f0-9]{64})(?:;|$)/)?.[1]; }
async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = sessionToken(req); if (!token) return null;
  return env.DB.prepare('SELECT u.id,u.email,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').bind(await digest(token), Date.now()).first<User>();
}
async function createSession(req: Request, env: Env, user: User) {
  const token = random();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(token), user.id, Date.now() + SESSION_SECONDS * 1000).run();
  return json({ user }, 200, { 'Set-Cookie': cookie(req, token) });
}
async function rateLimit(env: Env, key: string, limit: number, windowSeconds = 900) {
  const now = Date.now(); const bucket = Math.floor(now / (windowSeconds * 1000));
  const record = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(`${key}:${bucket}`, (bucket + 1) * windowSeconds * 1000).first<{ count: number }>();
  if ((record?.count ?? limit + 1) > limit) fail(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试');
}
const workspaceColumns = 'id,name,created_at AS createdAt,updated_at AS updatedAt';
const canvasColumns = 'c.id,c.workspace_id AS workspaceId,c.name,c.revision,c.created_at AS createdAt,c.updated_at AS updatedAt';
async function workspace(env: Env, id: string, user: User) {
  const row = await env.DB.prepare(`SELECT ${workspaceColumns} FROM workspaces WHERE id=? AND user_id=?`).bind(id, user.id).first();
  return row ?? fail(404, 'NOT_FOUND', '工作区不存在');
}
async function canvas(env: Env, id: string, user: User) {
  const row = await env.DB.prepare(`SELECT ${canvasColumns},c.object_key AS objectKey FROM canvases c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND w.user_id=?`).bind(id, user.id).first<Record<string, unknown> & { objectKey: string | null; revision: number }>();
  return row ?? fail(404, 'NOT_FOUND', '画布不存在');
}
function meta(row: Record<string, unknown>) { const { objectKey: _, ...rest } = row; return rest; }
async function readObject(env: Env, key: string | null, fallback: unknown) {
  if (!key) return fallback;
  const object = await env.DATA.get(key);
  if (!object) return fail(503, 'STORAGE_UNAVAILABLE', '保存的数据暂时无法读取，请稍后重试');
  return object.json();
}
async function deleteObjects(env: Env, keys: string[]) {
  // Keep each R2 bulk deletion within its per-request limit.
  for (let offset = 0; offset < keys.length; offset += 1000) await env.DATA.delete(keys.slice(offset, offset + 1000));
}
async function api(req: Request, env: Env, ctx: ExecutionContext) {
  const path = new URL(req.url).pathname; const method = req.method;
  if (!['GET', 'HEAD'].includes(method)) {
    if (req.headers.get('origin') !== new URL(req.url).origin || req.headers.get('x-requested-with') !== 'excalidraw-demo') fail(403, 'CSRF_REJECTED', '请求来源无效');
  }
  if (path === '/api/bootstrap' && method === 'GET') {
    const admin = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
    const settings = await env.DB.prepare('SELECT registration_enabled FROM settings WHERE id=1').first<{ registration_enabled: number }>();
    return json({ needsSetup: !admin, registrationEnabled: !!settings?.registration_enabled, emailVerification: false });
  }
  if (path === '/api/session' && method === 'GET') return json({ user: await currentUser(req, env) });
  if (['/api/setup', '/api/register', '/api/login'].includes(path) && method === 'POST') {
    await rateLimit(env, `auth-ip:${await digest(req.headers.get('cf-connecting-ip') ?? 'local')}`, 40);
    const data = await body(req); const { email, password } = credentials(data);
    await rateLimit(env, `auth-email:${await digest(email)}`, 15);
    ctx.waitUntil(env.DB.batch([env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now()), env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now())]));
    if (path === '/api/login') {
      const row = await env.DB.prepare('SELECT id,email,name,role,password_hash FROM users WHERE email=?').bind(email).first<User & { password_hash: string }>();
      const valid = await verifyPassword(password, row?.password_hash ?? `pbkdf2-sha256$100000$${'0'.repeat(64)}$${'0'.repeat(64)}`);
      if (!row || !valid) return fail(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
      const { password_hash: _, ...user } = row;
      return createSession(req, env, user);
    }
    const user: User = { id: crypto.randomUUID(), email, name: name(data.name, email.split('@')[0]), role: path === '/api/setup' ? 'admin' : 'user' };
    const now = new Date().toISOString(); const workspaceId = crypto.randomUUID();
    const insert = user.role === 'admin'
      ? env.DB.prepare('INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      : env.DB.prepare("INSERT INTO users(id,email,name,role,password_hash,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE role='admin') AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND registration_enabled=1)");
    try {
      const results = await env.DB.batch([
        insert.bind(user.id, email, user.name, user.role, await hashPassword(password), now),
        env.DB.prepare("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) SELECT ?,id,'我的工作区',?,? FROM users WHERE id=?").bind(workspaceId, now, now, user.id),
        env.DB.prepare("INSERT INTO canvases(id,workspace_id,name,created_at,updated_at) SELECT ?,id,'未命名画布',?,? FROM workspaces WHERE id=?").bind(crypto.randomUUID(), now, now, workspaceId),
        env.DB.prepare('INSERT INTO libraries(user_id,updated_at) SELECT id,? FROM users WHERE id=?').bind(now, user.id),
      ]);
      if (!results[0]?.meta.changes) return fail(403, 'REGISTRATION_DISABLED', '尚未初始化或管理员已关闭注册');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (String(error).includes('UNIQUE constraint failed')) return fail(409, 'ACCOUNT_EXISTS', user.role === 'admin' ? '管理员已创建，请登录' : '邮箱已经注册');
      throw error;
    }
    return createSession(req, env, user);
  }
  if (path === '/api/logout' && method === 'POST') {
    const token = sessionToken(req); if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
    return json({}, 200, { 'Set-Cookie': cookie(req, '', 0) });
  }
  const user = await currentUser(req, env); if (!user) return fail(401, 'UNAUTHENTICATED', '请先登录');
  if (path === '/api/admin/settings') {
    if (user.role !== 'admin') return fail(403, 'FORBIDDEN', '仅管理员可以修改注册设置');
    if (method === 'PATCH') {
      const data = await body(req); if (typeof data.registrationEnabled !== 'boolean') return fail(400, 'INVALID_SETTINGS', '注册设置必须是布尔值');
      await env.DB.prepare('UPDATE settings SET registration_enabled=? WHERE id=1').bind(data.registrationEnabled ? 1 : 0).run();
    } else if (method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
    const settings = await env.DB.prepare('SELECT registration_enabled FROM settings WHERE id=1').first<{ registration_enabled: number }>();
    return json({ registrationEnabled: !!settings?.registration_enabled });
  }
  if (path === '/api/workspaces') {
    if (method === 'GET') return json({ workspaces: (await env.DB.prepare(`SELECT ${workspaceColumns} FROM workspaces WHERE user_id=? ORDER BY created_at,id`).bind(user.id).all()).results });
    if (method === 'POST') {
      const data = await body(req); const id = crypto.randomUUID(); const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, user.id, name(data.name), now, now).run();
      return json({ workspace: await workspace(env, id, user) });
    }
  }
  const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)(\/canvases)?$/);
  if (wsMatch) {
    const id = wsMatch[1]!; await workspace(env, id, user);
    if (wsMatch[2]) {
      if (method === 'GET') return json({ canvases: (await env.DB.prepare(`SELECT ${canvasColumns} FROM canvases c WHERE c.workspace_id=? ORDER BY c.created_at,c.id`).bind(id).all()).results });
      if (method === 'POST') {
        const data = await body(req); const canvasId = crypto.randomUUID(); const now = new Date().toISOString();
        await env.DB.prepare('INSERT INTO canvases(id,workspace_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(canvasId, id, name(data.name, '未命名画布'), now, now).run();
        return json({ canvas: meta(await canvas(env, canvasId, user)) });
      }
    } else {
      if (method === 'PATCH') {
        const data = await body(req); await env.DB.prepare('UPDATE workspaces SET name=?,updated_at=? WHERE id=? AND user_id=?').bind(name(data.name), new Date().toISOString(), id, user.id).run();
        return json({ workspace: await workspace(env, id, user) });
      }
      if (method === 'DELETE') {
        // Capture the actual deleted snapshots in the same transaction as deletion.
        // A save between an earlier SELECT and DELETE could otherwise orphan its new R2 object.
        const results = await env.DB.batch<{ object_key: string | null }>([
          env.DB.prepare('DELETE FROM canvases WHERE workspace_id=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?) RETURNING object_key').bind(id, user.id),
          env.DB.prepare('DELETE FROM workspaces WHERE id=? AND user_id=?').bind(id, user.id),
        ]);
        const keys = results[0]!.results.flatMap(row => row.object_key ? [row.object_key] : []);
        if (keys.length) ctx.waitUntil(deleteObjects(env, keys));
        return json({});
      }
    }
  }
  const canvasMatch = path.match(/^\/api\/canvases\/([^/]+)$/);
  if (canvasMatch) {
    const id = canvasMatch[1]!; const row = await canvas(env, id, user);
    if (method === 'GET') {
      try { return json({ canvas: { ...meta(row), scene: await readObject(env, row.objectKey, EMPTY_SCENE) } }); }
      catch (error) {
        // An autosave may have replaced and removed this immutable object after the D1 read.
        if (!(error instanceof ApiError) || error.code !== 'STORAGE_UNAVAILABLE') throw error;
        const latest = await canvas(env, id, user);
        return json({ canvas: { ...meta(latest), scene: await readObject(env, latest.objectKey, EMPTY_SCENE) } });
      }
    }
    if (method === 'PATCH') {
      const data = await body(req); await env.DB.prepare('UPDATE canvases SET name=?,updated_at=? WHERE id=?').bind(name(data.name), new Date().toISOString(), id).run();
      return json({ canvas: meta(await canvas(env, id, user)) });
    }
    if (method === 'DELETE') {
      const deleted = await env.DB.prepare('DELETE FROM canvases WHERE id=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?) RETURNING object_key').bind(id, user.id).first<{ object_key: string | null }>();
      if (deleted?.object_key) ctx.waitUntil(env.DATA.delete(deleted.object_key));
      return json({});
    }
    if (method === 'PUT') {
      const data = await body(req); const scene = data.scene;
      if (!isObject(scene) || !Array.isArray(scene.elements) || !isObject(scene.appState) || !isObject(scene.files)) return fail(400, 'INVALID_SCENE', '画布数据格式无效');
      return saveSnapshot(env, ctx, user, 'canvas', id, row, data.revision, scene);
    }
  }
  if (path === '/api/library') {
    const row = await env.DB.prepare('SELECT revision,object_key AS objectKey FROM libraries WHERE user_id=?').bind(user.id).first<{ revision: number; objectKey: string | null }>();
    if (!row) return fail(500, 'LIBRARY_MISSING', '素材库未初始化');
    if (method === 'GET') {
      try { return json({ revision: row.revision, items: await readObject(env, row.objectKey, []) }); }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'STORAGE_UNAVAILABLE') throw error;
        const latest = await env.DB.prepare('SELECT revision,object_key AS objectKey FROM libraries WHERE user_id=?').bind(user.id).first<{ revision: number; objectKey: string | null }>();
        if (!latest) throw error;
        return json({ revision: latest.revision, items: await readObject(env, latest.objectKey, []) });
      }
    }
    if (method === 'PUT') {
      const data = await body(req); if (!Array.isArray(data.items)) return fail(400, 'INVALID_LIBRARY', '素材库数据格式无效');
      return saveSnapshot(env, ctx, user, 'library', user.id, row, data.revision, data.items);
    }
  }
  return fail(404, 'NOT_FOUND', '接口不存在');
}
async function saveSnapshot(env: Env, ctx: ExecutionContext, user: User, type: 'canvas' | 'library', id: string, row: { revision: number; objectKey: string | null }, revision: unknown, value: unknown) {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return fail(400, 'INVALID_REVISION', '版本号无效');
  if (row.revision !== revision) return fail(409, 'REVISION_CONFLICT', '其他页面已经修改了内容，请重新加载后再编辑');
  const key = `${user.id}/${type}/${id}/${crypto.randomUUID()}.json`; const now = new Date().toISOString();
  await env.DATA.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
  let result: D1Result;
  try {
    result = type === 'canvas'
      ? await env.DB.prepare('UPDATE canvases SET object_key=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?)').bind(key, now, id, revision, user.id).run()
      : await env.DB.prepare('UPDATE libraries SET object_key=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?').bind(key, now, user.id, revision).run();
  } catch (error) { ctx.waitUntil(env.DATA.delete(key)); throw error; }
  if (!result.meta.changes) { ctx.waitUntil(env.DATA.delete(key)); return fail(409, 'REVISION_CONFLICT', '其他页面已经修改或删除了内容，请重新加载'); }
  // Never overwrite existing R2 keys: D1 switches the authoritative revision atomically.
  if (row.objectKey) ctx.waitUntil(env.DATA.delete(row.objectKey));
  return json({ revision: (revision as number) + 1, updatedAt: now });
}
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!new URL(req.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try { return await api(req, env, ctx); }
    catch (error) {
      if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
      console.error('API operation failed', error instanceof Error ? error.message : 'unknown');
      return json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
