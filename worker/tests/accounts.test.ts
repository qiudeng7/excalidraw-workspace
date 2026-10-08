import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { Miniflare } from 'miniflare';

test('accounts, first administrator, owner isolation, revisions and registration settings', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01', d1Databases: { DB: 'test-db' }, r2Buckets: { DATA: 'test-data' } });
  try {
    const db = await mf.getD1Database('DB');
    const migration = await readFile(new URL('../../migrations/0001_accounts.sql', import.meta.url), 'utf8');
    await db.exec(migration.replace(/\n/g, ' '));
    const request = async (path: string, method = 'GET', data?: unknown, cookie?: string, origin = 'https://demo.test') => {
      const response = await mf.dispatchFetch(`https://demo.test/api${path}`, {
        method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Requested-With': 'excalidraw-demo', ...(cookie ? { Cookie: cookie } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    assert.equal((await request('/bootstrap')).body.needsSetup, true);
    assert.equal((await request('/register', 'POST', { email: 'early@example.com', password: 'strong-password-123' })).status, 403);
    const setup = await Promise.all(['admin1', 'admin2'].map(email => request('/setup', 'POST', { email: `${email}@example.com`, password: 'strong-password-123' })));
    assert.deepEqual(setup.map(r => r.status).sort(), [200, 409]);
    const admin = setup.find(r => r.status === 200)!; assert.ok(admin.cookie);
    assert.equal(admin.body.user.role, 'admin');
    assert.equal((await request('/bootstrap')).body.needsSetup, false);
    assert.equal((await request('/session', 'GET', undefined, admin.cookie)).body.user.id, admin.body.user.id);
    const alice = await request('/register', 'POST', { email: 'alice@example.com', password: 'strong-password-123', role: 'admin' });
    const bob = await request('/register', 'POST', { email: 'bob@example.com', password: 'strong-password-123' });
    assert.equal(alice.body.user.role, 'user'); assert.ok(alice.cookie); assert.ok(bob.cookie);
    assert.equal((await request('/admin/settings', 'PATCH', { registrationEnabled: false }, alice.cookie)).status, 403);
    assert.equal((await request('/admin/settings', 'PATCH', { registrationEnabled: false }, admin.cookie, 'https://evil.test')).status, 403);
    assert.equal((await request('/admin/settings', 'PATCH', { registrationEnabled: false }, admin.cookie)).status, 200);
    assert.equal((await request('/register', 'POST', { email: 'closed@example.com', password: 'strong-password-123' })).status, 403);
    const workspace = (await request('/workspaces', 'GET', undefined, alice.cookie)).body.workspaces[0];
    const canvas = (await request(`/workspaces/${workspace.id}/canvases`, 'GET', undefined, alice.cookie)).body.canvases[0];
    for (const path of [`/workspaces/${workspace.id}/canvases`, `/canvases/${canvas.id}`]) {
      assert.equal((await request(path, 'GET', undefined, bob.cookie)).status, 404);
    }
    assert.equal((await request(`/workspaces/${workspace.id}`, 'DELETE', undefined, bob.cookie)).status, 404);
    const scene = { elements: [{ id: 'element-a', type: 'rectangle' }], appState: { viewBackgroundColor: '#fff' }, files: { image: { dataURL: 'data:image/png;base64,abcd' } } };
    const saves = await Promise.all([1, 2].map(() => request(`/canvases/${canvas.id}`, 'PUT', { revision: 0, scene }, alice.cookie)));
    assert.deepEqual(saves.map(r => r.status).sort(), [200, 409]);
    const loaded = (await request(`/canvases/${canvas.id}`, 'GET', undefined, alice.cookie)).body.canvas;
    assert.equal(loaded.revision, 1); assert.deepEqual(loaded.scene, scene);
    assert.equal((await request(`/canvases/${canvas.id}`, 'PUT', { revision: 1, scene }, bob.cookie)).status, 404);
    assert.equal((await request('/library', 'PUT', { revision: 0, items: [{ id: 'library-a', elements: [] }] }, alice.cookie)).status, 200);
    assert.equal((await request('/library', 'PUT', { revision: 0, items: [] }, alice.cookie)).status, 409);
    assert.deepEqual((await request('/library', 'GET', undefined, bob.cookie)).body, { revision: 0, items: [] });
    assert.equal((await request('/library', 'GET', undefined, alice.cookie)).body.items[0].id, 'library-a');
    assert.equal((await request('/login', 'POST', { email: 'alice@example.com', password: 'wrong-password-123' })).status, 401);
    assert.equal((await request('/login', 'POST', { email: 'ALICE@example.com', password: 'strong-password-123' })).status, 200);
    assert.equal((await request('/logout', 'POST', undefined, alice.cookie)).status, 200);
    assert.equal((await request('/session', 'GET', undefined, alice.cookie)).body.user, null);
    assert.equal((await request('/workspaces', 'GET', undefined, alice.cookie)).status, 401);
    assert.equal((await request(`/workspaces/${workspace.id}`, 'DELETE', undefined, admin.cookie)).status, 404);
    const bobWs = (await request('/workspaces', 'GET', undefined, bob.cookie)).body.workspaces[0];
    const bobCanvas = (await request(`/workspaces/${bobWs.id}/canvases`, 'GET', undefined, bob.cookie)).body.canvases[0];
    const extraCanvas = (await request(`/workspaces/${bobWs.id}/canvases`, 'POST', { name: 'Delete snapshot' }, bob.cookie)).body.canvas;
    const bucket = await mf.getR2Bucket('DATA');
    const deletedKeys: string[] = [];
    for (const entry of [bobCanvas, extraCanvas]) {
      assert.equal((await request(`/canvases/${entry.id}`, 'PUT', { revision: 0, scene }, bob.cookie)).status, 200);
      const saved = await db.prepare('SELECT object_key FROM canvases WHERE id=?').bind(entry.id).first<{ object_key: string }>();
      assert.ok(saved?.object_key);
      deletedKeys.push(saved.object_key);
      assert.ok(await bucket.get(saved.object_key));
    }
    assert.equal((await request(`/canvases/${extraCanvas.id}`, 'DELETE', undefined, bob.cookie)).status, 200);
    assert.equal((await request(`/workspaces/${bobWs.id}`, 'DELETE', undefined, bob.cookie)).status, 200);
    assert.deepEqual((await request('/workspaces', 'GET', undefined, bob.cookie)).body.workspaces, []);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM canvases WHERE workspace_id=?').bind(bobWs.id).first()).count, 0);
    // R2 cleanup runs through waitUntil after the API response.
    for (const key of deletedKeys) {
      for (let attempt = 0; attempt < 30 && await bucket.get(key); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await bucket.get(key), null);
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").first()).count, 1);
  } finally { await mf.dispose(); }
});
