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

// replace the /v1/resolve handler body with this
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const keyRaw = String(req.query.store_key || '').trim();
  const key = normalizeStoreKey(store, keyRaw);
  if (!store || !key) return res.json({ asin: null });

  try {
    const q = `
      SELECT a.asin
      FROM public.listings l
      JOIN public.asins a ON a.id = l.variant_id
      WHERE lower(trim(l.store)) = lower(trim($1))
        AND (
          trim(l.store_sku) = $2
          OR trim(regexp_replace(l.store_sku, '^[Aa][- ]?', '', 'i')) = $2
        )
      ORDER BY l.current_price_observed_at DESC NULLS LAST, l.id DESC
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

// replace the /v1/compare handler body with this
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH the_variant AS (
        SELECT a.id AS variant_id, a.asin, p.title AS product_title, a.variant_label,
               a.current_price_cents AS amazon_price_cents,
               a.current_price_observed_at AS amazon_observed_at
        FROM public.asins a
        JOIN public.products p ON p.id = a.product_id
        WHERE upper(a.asin) = $1
      ),
      other_stores AS (
        SELECT l.store, l.store_sku, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at,
               l.notes
        FROM public.listings l
        JOIN the_variant v ON v.variant_id = l.variant_id
      )
      SELECT
        'Amazon'::text AS store,
        v.asin,
        NULL::text AS store_sku,
        NULLIF(v.amazon_price_cents, NULL) AS price_cents,
        v.amazon_observed_at AS observed_at,
        NULL::text AS url,
        COALESCE(v.product_title, '') AS title,
        NULL::text AS notes
      FROM the_variant v
      UNION ALL
      SELECT
        o.store, (SELECT asin FROM the_variant), o.store_sku, o.price_cents, o.observed_at, o.url,
        NULL::text AS title,
        o.notes
      FROM other_stores o
      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;

    const { rows } = await pool.query(sql, [asin]);

    res.json({
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title,         // Amazon row has product title, others usually do not
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin,
        seen_at: r.observed_at,
        notes: r.notes || null
      }))
    });
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ results: [] });
  }
});

// start and shutdown
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
