// server.js - ASIN-first compare API + resolver using price_feed only

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// CORS first
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept']
}));
app.options('*', cors());

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true, version: 'v8' }));

// Helper: normalize per store
function normalizeStoreKey(store, key) {
  if (!key) return '';
  const s = String(store || '').toLowerCase();
  let k = String(key || '').trim();
  if (s === 'target') {
    k = k.replace(/^A[-\s]?/i, '');     // A-12345678 -> 12345678
    k = k.replace(/[^0-9A-Z]/g, '');    // keep digits/letters
  } else if (s === 'walmart' || s === 'bestbuy') {
    k = k.replace(/\D+/g, '');          // digits only
  }
  return k;
}

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

// GET /v1/resolve?store=Target&store_key=12345678
// Uses price_feed as the mapping source: looks for any row where (store, store_sku) has an ASIN
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const keyRaw = String(req.query.store_key || '').trim();
  const key = normalizeStoreKey(store, keyRaw);
  if (!store || !key) return res.json({ asin: null });

  try {
    const q = `
      SELECT asin
      FROM public.price_feed
      WHERE lower(store) = lower($1)
        AND store_sku = $2
        AND asin IS NOT NULL
      ORDER BY observed_at DESC NULLS LAST
      LIMIT 1
    `;
    const r = await pool.query(q, [store, key]);
    const asin = r.rows[0]?.asin ? String(r.rows[0].asin).toUpperCase() : null;
    return res.json({ asin });
  } catch (e) {
    console.error('resolve error:', e);
    return res.json({ asin: null });
  }
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
});

// Shutdown
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
