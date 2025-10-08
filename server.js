// at top
const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/health', (_req, res) => res.json({ ok: true, version: 'v9-debug' })); // bump version

function normalizeStoreKey(store, key) {
  if (!key) return '';
  const s = String(store || '').toLowerCase();
  let k = String(key || '').trim();
  if (s === 'target') {
    k = k.replace(/^A[-\s]?/i, '');
    k = k.replace(/[^0-9A-Z]/g, '');
  } else if (s === 'walmart' || s === 'bestbuy') {
    k = k.replace(/\D+/g, '');
  }
  return k;
}

// tolerant resolver
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const keyRaw = String(req.query.store_key || '').trim();
  const key = normalizeStoreKey(store, keyRaw);
  if (!store || !key) return res.json({ asin: null });

  console.log('resolve req', { store, keyRaw, normalized: key });

  try {
    const q = `
      SELECT asin
      FROM public.price_feed
      WHERE lower(trim(store)) = lower(trim($1))
        AND (
          trim(store_sku) = $2
          OR trim(regexp_replace(store_sku, '^[Aa][- ]?', '', 'i')) = $2
        )
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

// compare route (unchanged if you already have it)
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });
  try {
    const { rows } = await pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (store)
          store, asin, url, COALESCE(title,'') AS title, price_cents, observed_at
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
    res.json({
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title,
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin,
        seen_at: r.observed_at
      }))
    });
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ results: [] });
  }
});

// debug routes
app.get('/debug/whoami', async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        current_database() AS db,
        current_user AS user,
        current_setting('server_version') AS version,
        current_setting('TimeZone') AS tz,
        current_setting('search_path') AS search_path
    `);
    res.json({ ok: true, info: r.rows[0] });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

app.get('/debug/peek', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const keyRaw = String(req.query.store_key || '').trim();
  const key = normalizeStoreKey(store, keyRaw);
  try {
    const r = await pool.query(
      `
      SELECT id, store, store_sku, asin, price_cents, observed_at
      FROM public.price_feed
      WHERE lower(trim(store)) = lower(trim($1))
        AND (
          trim(store_sku) = $2
          OR trim(regexp_replace(store_sku, '^[Aa][- ]?', '', 'i')) = $2
        )
      ORDER BY observed_at DESC NULLS LAST
      LIMIT 10
      `,
      [store, key]
    );
    res.json({ store, keyRaw, normalizedKey: key, rows: r.rows });
  } catch (e) {
    res.json({ error: String(e) });
  }
});

// start and shutdown
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
