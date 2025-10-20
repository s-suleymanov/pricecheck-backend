// server.js
const express = require('express');
const { Pool } = require('pg');

const app = express();

// JSON and CORS
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Utils
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

// UPC normalization snippet for SQL joins
const NORM_UPC_SQL = (expr) => `
  CASE
    WHEN ${expr} IS NULL THEN NULL
    ELSE
      CASE
        WHEN btrim(${expr}) ~ '^0[0-9]{12}$' THEN substring(btrim(${expr}) from 2) -- drop leading 0 on EAN13
        WHEN btrim(${expr}) ~ '^[0-9]{12}$' THEN btrim(${expr})
        ELSE btrim(${expr})
      END
  END
`;

// Health
app.get('/health', (_req, res) => res.json({ ok: true, version: 'v13-upc-first-correct-variant' }));

// Resolve: find listing, prefer UPC to map to ASIN, else use listing.asin
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const rawKey = String(req.query.store_key || '').trim();
  const key = normalizeStoreKey(store, rawKey);
  if (!store || !key) return res.json({ asin: null });

  try {
    const rL = await pool.query(
      `SELECT l.asin, l.upc
         FROM public.listings l
        WHERE lower(btrim(l.store)) = lower(btrim($1))
          AND btrim(l.store_sku) = $2
        ORDER BY l.current_price_observed_at DESC NULLS LAST, l.id DESC
        LIMIT 1`,
      [store, key]
    );
    const l = rL.rows[0];
    if (!l) return res.json({ asin: null });

    if (l.upc) {
      const rA = await pool.query(
        `SELECT asin FROM public.asins
          WHERE ${NORM_UPC_SQL('upc')} = ${NORM_UPC_SQL('$1')}
            AND asin IS NOT NULL
          LIMIT 1`,
        [l.upc]
      );
      if (rA.rows[0]?.asin) return res.json({ asin: String(rA.rows[0].asin).toUpperCase() });
    }

    if (l.asin) return res.json({ asin: String(l.asin).toUpperCase() });

    return res.json({ asin: null });
  } catch (e) {
    console.error('resolve error:', e);
    return res.json({ asin: null });
  }
});

// Compare: ASIN -> get UPC from asins -> match listings by UPC first, else ASIN (case-insensitive)
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH v AS (
        SELECT a.asin,
               a.upc,
               a.variant_label,
               a.current_price_cents        AS amazon_price_cents,
               a.current_price_observed_at  AS amazon_observed_at,
               p.title                      AS product_title,
               p.brand,
               p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE upper(a.asin) = $1
         LIMIT 1
      ),
      match_upc AS (
        SELECT l.store, l.store_sku, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN v ON ${NORM_UPC_SQL('v.upc')} IS NOT NULL
               AND ${NORM_UPC_SQL('l.upc')} = ${NORM_UPC_SQL('v.upc')}
      ),
      match_asin AS (
        SELECT l.store, l.store_sku, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN v ON upper(l.asin) = v.asin
      ),
      chosen AS (
        SELECT * FROM match_upc
        UNION ALL
        SELECT * FROM match_asin
        WHERE NOT EXISTS (SELECT 1 FROM match_upc LIMIT 1)
      )
      -- Amazon row only if it has a current price
      SELECT
        'Amazon'::text AS store,
        v.asin,
        NULL::text AS store_sku,
        v.amazon_price_cents AS price_cents,
        v.amazon_observed_at AS observed_at,
        NULL::text AS url,
        v.product_title AS title,
        v.brand,
        v.category,
        v.variant_label
      FROM v
      WHERE v.amazon_price_cents IS NOT NULL

      UNION ALL

      -- Other stores
      SELECT
        c.store,
        (SELECT asin FROM v),
        c.store_sku,
        c.price_cents,
        c.observed_at,
        c.url,
        (SELECT product_title FROM v) AS title,
        NULL::text AS brand,
        NULL::text AS category,
        NULL::text AS variant_label
      FROM chosen c

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
        seen_at: r.observed_at,
        brand: r.brand || null,
        category: r.category || null,
        variant_label: r.variant_label || null
      }))
    });
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ results: [] });
  }
});

// Observe: write price_history and ensure holders exist
app.post('/v1/observe', async (req, res) => {
  const { store, asin, store_sku, price_cents, url, title, observed_at } = req.body || {};

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
      if (!/^[A-Z0-9]{10}$/.test(asinUp)) throw new Error('asin required for Amazon');

      await client.query(
        `INSERT INTO public.asins (product_id, asin)
         VALUES (NULL, $1)
         ON CONFLICT (asin) DO NOTHING`,
        [asinUp]
      );

      await client.query(
        `INSERT INTO public.price_history (store, asin, price_cents, observed_at, url, title)
         VALUES ('Amazon', $1, $2, COALESCE($3::timestamptz, now()), $4, $5)`,
        [asinUp, cents, observed_at || null, url || null, title || null]
      );

    } else {
      if (!skuNorm) throw new Error('store_sku required for non Amazon stores');

      await client.query(
        `INSERT INTO public.listings (store, store_sku, url, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (store, store_sku)
         DO UPDATE SET url = EXCLUDED.url`,
        [storeNorm, skuNorm, url || null]
      );

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

// Start
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));

// Graceful shutdown
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
