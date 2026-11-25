import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildPoolConfig, createApp, initDb } from './server.js';

function createMemoryDb() {
  let nextId = 1;
  const rows = [];

  return {
    async query(sql, params = []) {
      const q = sql.trim();
      if (q === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };

      if (q.startsWith('SELECT id, title, done')) {
        return { rows: [...rows].reverse(), rowCount: rows.length };
      }

      if (q.startsWith('INSERT INTO items')) {
        const item = {
          id: nextId++,
          title: params[0],
          done: false,
          created_at: new Date().toISOString(),
        };
        rows.push(item);
        return { rows: [item], rowCount: 1 };
      }

      if (q.startsWith('UPDATE items')) {
        const [done, id] = params;
        const item = rows.find((r) => r.id === id);
        if (!item) return { rows: [], rowCount: 0 };
        item.done = done === null ? !item.done : done;
        return { rows: [{ ...item }], rowCount: 1 };
      }

      if (q.startsWith('DELETE FROM items')) {
        const idx = rows.findIndex((r) => r.id === params[0]);
        if (idx === -1) return { rows: [], rowCount: 0 };
        const [removed] = rows.splice(idx, 1);
        return { rows: [{ id: removed.id }], rowCount: 1 };
      }

      throw new Error(`Unexpected query in stub: ${q}`);
    },
  };
}

async function withServer(db, fn) {
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health endpoint reports connected and 503 on DB failure', async () => {
  await withServer(createMemoryDb(), async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: 'connected' });
  });

  const brokenDb = {
    async query() {
      throw new Error('connection refused');
    },
  };
  await withServer(brokenDb, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, db: 'disconnected' });
  });
});

test('CRUD lifecycle and input validation', async () => {
  await withServer(createMemoryDb(), async (base) => {
    // Reject empty, whitespace, oversized, and malformed JSON bodies
    for (const badBody of [{}, { title: '   ' }, { title: 123 }, { title: 'a'.repeat(201) }]) {
      const res = await fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(badBody),
      });
      assert.equal(res.status, 400);
    }

    const badJson = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(badJson.status, 400);

    // Create item (trims whitespace)
    const createRes = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  Deploy to AWS  ' }),
    });
    assert.equal(createRes.status, 201);
    const { item } = await createRes.json();
    assert.equal(item.title, 'Deploy to AWS');
    assert.equal(item.done, false);

    // List items
    const listRes = await fetch(`${base}/api/items`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.items.length, 1);

    // Validate ID and done field on PATCH
    assert.equal((await fetch(`${base}/api/items/abc`, { method: 'PATCH' })).status, 400);
    assert.equal((await fetch(`${base}/api/items/0`, { method: 'PATCH' })).status, 400);
    assert.equal((await fetch(`${base}/api/items/999`, { method: 'PATCH' })).status, 404);
    assert.equal(
      (
        await fetch(`${base}/api/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: 'yes' }),
        })
      ).status,
      400,
    );

    const patchRes = await fetch(`${base}/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).item.done, true);

    // Delete item and verify 404 afterwards
    assert.equal((await fetch(`${base}/api/items/bad`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' })).status, 404);
  });
});

test('unexpected DB errors do not leak internal details', async () => {
  const secretErrDb = {
    async query() {
      throw new Error('password authentication failed for user secret_admin');
    },
  };
  await withServer(secretErrDb, async (base) => {
    const res = await fetch(`${base}/api/items`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: 'internal server error' });
  });
});

test('live PostgreSQL integration (when DATABASE_URL is set)', { skip: !process.env.DATABASE_URL }, async () => {
  const pool = new pg.Pool(buildPoolConfig());
  try {
    await initDb(pool);
    await withServer(pool, async (base) => {
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);

      const created = await fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'CI postgres check' }),
      });
      assert.equal(created.status, 201);
      const { item } = await created.json();

      const toggled = await fetch(`${base}/api/items/${item.id}`, { method: 'PATCH' });
      assert.equal(toggled.status, 200);
      assert.equal((await toggled.json()).item.done, true);

      const del = await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' });
      assert.equal(del.status, 204);
    });
  } finally {
    await pool.end();
  }
});

