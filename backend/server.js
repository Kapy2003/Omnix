import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import pg from 'pg';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parseId = (s) => (/^[1-9]\d*$/.test(s) && Number.isSafeInteger(+s) ? +s : null);

export function buildPoolConfig() {
  let ssl = false;
  if (process.env.DB_SSL_CA) {
    ssl = { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  } else if (process.env.DB_SSL === 'true') {
    // ponytail: fallback when DB_SSL_CA isn't configured; set DB_SSL_CA to AWS RDS global-bundle.pem in strict prod
    ssl = { rejectUnauthorized: false };
  }
  return { connectionString: process.env.DATABASE_URL, ssl };
}

export async function initDb(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  if (process.env.NODE_ENV !== 'production') {
    app.use(express.static(fileURLToPath(new URL('../frontend', import.meta.url))));
  }

  app.get('/api/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, db: 'connected' });
    } catch (err) {
      console.error('Healthcheck DB error:', err.message);
      res.status(503).json({ ok: false, db: 'disconnected' });
    }
  });

  app.get(
    '/api/items',
    wrap(async (_req, res) => {
      const { rows } = await db.query(
        'SELECT id, title, done, created_at FROM items ORDER BY id DESC LIMIT 100',
      );
      res.json({ items: rows });
    }),
  );

  app.post(
    '/api/items',
    wrap(async (req, res) => {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title || title.length > 200) {
        return res.status(400).json({ error: 'title must be 1-200 characters' });
      }
      const { rows } = await db.query(
        'INSERT INTO items (title) VALUES ($1) RETURNING id, title, done, created_at',
        [title],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  app.patch(
    '/api/items/:id',
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'invalid item id' });

      const hasDone = req.body?.done !== undefined;
      if (hasDone && typeof req.body.done !== 'boolean') {
        return res.status(400).json({ error: 'done must be a boolean' });
      }

      const { rows, rowCount } = await db.query(
        'UPDATE items SET done = COALESCE($1::boolean, NOT done) WHERE id = $2 RETURNING id, title, done, created_at',
        [hasDone ? req.body.done : null, id],
      );
      if (!rowCount) return res.status(404).json({ error: 'item not found' });
      res.json({ item: rows[0] });
    }),
  );

  app.delete(
    '/api/items/:id',
    wrap(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'invalid item id' });

      const { rowCount } = await db.query('DELETE FROM items WHERE id = $1 RETURNING id', [id]);
      if (!rowCount) return res.status(404).json({ error: 'item not found' });
      res.status(204).end();
    }),
  );

  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new pg.Pool(buildPoolConfig());
  await initDb(pool);

  const port = Number(process.env.PORT) || 3000;
  const server = createApp(pool).listen(port, () => {
    console.log(`Omnix API listening on port ${port}`);
  });

  const shutdown = () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
}
