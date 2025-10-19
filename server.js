// server.js
const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json({ limit: '256kb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/health', (_req, res) => res.json({ ok: true, version: 'v10-price-history' }));

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

/**
 * GET /v1/resolve?store=Target&store_key=12345678
 * Returns { asin: "B0..." | null }
 * Looks up a listing by (store, store_sku) and returns its mapped ASIN, if set.
 */
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const rawKey = String(req.query.store_key || '').trim();
  const key = normalizeStoreKey(store, rawKey);
  if (!store || !key) return res.json({ asin: null });

  try {
    const q = `
      SELECT l.asin
      FROM public.listings l
      WHERE lower(trim(l.store)) = lower(trim($1))
        AND trim(l.store_sku) = $2
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

/**
 * GET /v1/compare?asin=B0XXXXXXXX
 * Returns { results: [...] } merging Amazon variant and all mapped store listings.
 */
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH the_variant AS (
        SELECT a.asin,
               a.id AS asin_row_id,
               a.variant_label,
               a.current_price_cents  AS amazon_price_cents,
               a.current_price_observed_at AS amazon_observed_at,
               p.title AS product_title
        FROM public.asins a
        JOIN public.products p ON p.id = a.product_id
        WHERE upper(a.asin) = $1
      ),
      other_stores AS (
        SELECT l.store, l.store_sku, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at,
               l.title,
               l.status
        FROM public.listings l
        JOIN the_variant v ON v.asin = l.asin
      )
      SELECT
        'Amazon'::text AS store,
        v.asin,
        NULL::text AS store_sku,
        v.amazon_price_cents AS price_cents,
        v.amazon_observed_at AS observed_at,
        NULL::text AS url,
        v.product_title AS title,
        NULL::text AS notes
      FROM the_variant v
      UNION ALL
      SELECT
        o.store,
        (SELECT asin FROM the_variant),
        o.store_sku,
        o.price_cents,
        o.observed_at,
        o.url,
        COALESCE(o.title, (SELECT product_title FROM the_variant)),
        NULL::text AS notes
      FROM other_stores o
      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;
    const { rows } = await pool.query(sql, [asin]);

    res.json({
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title || '',
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin,
        store_sku: r.store_sku,
        seen_at: r.observed_at
      }))
    });
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ results: [] });
  }
});

/**
 * POST /v1/observe
 * Body: { store, asin?, store_sku?, price_cents, url?, title?, observed_at? }
 * Behavior:
 *  - Ensures existence of holder row (asins for Amazon, listings for others)
 *  - Inserts into price_history
 *  - Trigger updates current_price_* on holder
 */
app.post('/v1/observe', async (req, res) => {
  const {
    store,
    asin,
    store_sku,
    price_cents,
    url,
    title,
    observed_at
  } = req.body || {};

  const storeNorm = String(store || '').trim();
  const skuNorm = normalizeStoreKey(storeNorm, store_sku || null);
  const cents = Number.isFinite(price_cents) ? price_cents : null;

  if (!storeNorm || !Number.isFinite(cents)) {
    return res.status(400).json({ ok: false, error: 'store and price_cents required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (storeNorm.toLowerCase() === 'amazon') {
      const asinUp = String(asin || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asinUp)) {
        throw new Error('asin required for Amazon');
      }

      // Ensure asins row exists (product_id may be null; you can set later)
      await client.query(
        `INSERT INTO public.asins (product_id, asin)
         VALUES (NULL, $1)
         ON CONFLICT (asin) DO NOTHING`,
        [asinUp]
      );

      // Insert price_history event
      await client.query(
        `INSERT INTO public.price_history (store, asin, price_cents, observed_at, url, title)
         VALUES ('Amazon', $1, $2, COALESCE($3::timestamptz, now()), $4, $5)`,
        [asinUp, cents, observed_at || null, url || null, title || null]
      );

    } else {
      if (!skuNorm) throw new Error('store_sku required for non Amazon stores');

      // Ensure listing row exists
      await client.query(
        `INSERT INTO public.listings (store, store_sku, url, title, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (store, store_sku)
         DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title`,
        [storeNorm, skuNorm, url || null, title || null]
      );

      // Insert price_history event
      await client.query(
        `INSERT INTO public.price_history (store, store_sku, price_cents, observed_at, url, title)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)`,
        [storeNorm, skuNorm, cents, observed_at || null, url || null, title || null]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('observe error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// start and shutdown
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
