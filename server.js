// server.js - ASIN-first compare API + id_map resolver

const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/health', (_req, res) => res.json({ ok: true, version: 'v7' }));

// GET /v1/compare?asin=B0XXXXXXX
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const { rows } = await pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (store)
          store,
          asin,
          url,
          COALESCE(title, '')  AS title,
          price_cents,
          observed_at
        FROM public.price_feed
        WHERE asin = $1
        ORDER BY store, observed_at DESC
      )
      SELECT store, asin, url, title, price_cents, observed_at
      FROM latest
      ORDER BY price_cents ASC NULLS LAST, store ASC
      `,
      [asin]
    );

    const results = rows.map(r => ({
      store: r.store,
      product_name: r.title,
      price_cents: r.price_cents,
      url: r.url,
      currency: 'USD',
      asin: r.asin,
      seen_at: r.observed_at
    }));

    return res.json({ results });
  } catch (err) {
    console.error('compare error:', err);
    return res.status(500).json({ results: [] });
  }
});

// GET /v1/resolve?store=Target&store_key=A-12345678&title=...
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const key   = String(req.query.store_key || '').trim();
  if (!store || !key) return res.json({ asin: null });

  try {
    const r = await pool.query(
      `SELECT asin FROM public.id_map WHERE store = $1 AND store_key = $2 LIMIT 1`,
      [store, key]
    );
    const asin = r.rows[0]?.asin ? String(r.rows[0].asin).toUpperCase() : null;
    return res.json({ asin });
  } catch (err) {
    console.error('resolve error:', err);
    return res.json({ asin: null });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
});

process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
