// server.js
const express = require('express');
const { Pool } = require('pg');

const app = express();

// JSON + CORS
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

// -------- helpers --------

// Normalize any UPC to digits only; if 13 digits and starts with 0, drop that 0 (EAN→UPC).
const NORM_UPC_SQL = (expr) => `
  CASE
    WHEN ${expr} IS NULL THEN NULL
    ELSE
      CASE
        WHEN length(regexp_replace(btrim(${expr}), '[^0-9]', '', 'g')) = 13
         AND left(regexp_replace(btrim(${expr}), '[^0-9]', '', 'g'), 1) = '0'
          THEN substring(regexp_replace(btrim(${expr}), '[^0-9]', '', 'g') from 2)
        ELSE regexp_replace(btrim(${expr}), '[^0-9]', '', 'g')
      END
  END
`;

// For incoming keys from the extension. We now treat “store_key” as UPC.
function normalizeKeyAsUPC(key) {
  if (!key) return '';
  // digits only
  let k = String(key).replace(/[^0-9]/g, '');
  // if 13-digit starting with 0, drop it
  if (k.length === 13 && k.startsWith('0')) k = k.slice(1);
  return k;
}

app.get('/health', (_req, res) => res.json({ ok: true, version: 'v15-listings-upc-only' }));

/**
 * GET /v1/resolve?store=Target&store_key=<UPC or whatever the page gave>
 * Returns { asin: "B0XXXXXXXXX" | null }
 * Logic:
 *  1) Find listing by (store, upc) — we treat store_key as UPC now.
 *  2) If listing.upc maps to an asins.upc, return that ASIN.
 *  3) Else fall back to listing.asin if it exists.
 */
app.get('/v1/resolve', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const upcKey = normalizeKeyAsUPC(req.query.store_key || '');
  if (!store || !upcKey) return res.json({ asin: null });

  try {
    const rL = await pool.query(
      `SELECT l.asin, l.upc
         FROM public.listings l
        WHERE lower(btrim(l.store)) = lower(btrim($1))
          AND ${NORM_UPC_SQL('l.upc')} = ${NORM_UPC_SQL('$2')}
        ORDER BY l.current_price_observed_at DESC NULLS LAST, l.id DESC
        LIMIT 1`,
      [store, upcKey]
    );
    const l = rL.rows[0];
    if (!l) return res.json({ asin: null });

    if (l.upc) {
      const rA = await pool.query(
        `SELECT asin
           FROM public.asins
          WHERE ${NORM_UPC_SQL('upc')} = ${NORM_UPC_SQL('$1')}
            AND asin IS NOT NULL
          LIMIT 1`,
        [l.upc]
      );
      if (rA.rows[0]?.asin) {
        return res.json({ asin: String(rA.rows[0].asin).toUpperCase() });
      }
    }

    if (l.asin) return res.json({ asin: String(l.asin).toUpperCase() });
    return res.json({ asin: null });
  } catch (e) {
    console.error('resolve error:', e);
    return res.json({ asin: null });
  }
});

/**
 * GET /v1/compare?asin=B0XXXXXXXXX
 * Returns { results: [...] }
 * Logic:
 *  1) Look up that ASIN in asins; get its UPC (+ product info).
 *  2) First, match listings by UPC (listings.upc).
 *  3) If none, fall back to match listings by ASIN (case-insensitive).
 *  4) Include Amazon row only if asins.current_price_cents is set.
 */
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
        SELECT l.store, l.upc, l.url,
               l.current_price_cents        AS price_cents,
               l.current_price_observed_at  AS observed_at
          FROM public.listings l
          JOIN v ON ${NORM_UPC_SQL('v.upc')} IS NOT NULL
                 AND ${NORM_UPC_SQL('l.upc')} = ${NORM_UPC_SQL('v.upc')}
      ),
      match_asin AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents        AS price_cents,
               l.current_price_observed_at  AS observed_at
          FROM public.listings l
          JOIN v ON upper(l.asin) = v.asin
      ),
      chosen AS (
        SELECT * FROM match_upc
        UNION ALL
        SELECT * FROM match_asin
        WHERE NOT EXISTS (SELECT 1 FROM match_upc LIMIT 1)
      )
      -- Amazon (only if it has a current price)
      SELECT
        'Amazon'::text AS store,
        v.asin,
        v.upc AS upc,
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
        c.upc,
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
        asin: r.asin,       // from SELECT layout above
        upc: r.upc ?? null, // for non-Amazon rows
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

/**
 * POST /v1/observe
 * Body: { store, asin?, upc?, price_cents, url?, title?, observed_at? }
 * NOTE: since listings no longer has store_sku, we treat the provided "upc" as the unique key with store.
 * We still write the UPC into price_history.store_sku so your trigger can read it.
 */
app.post('/v1/observe', async (req, res) => {
  const { store, asin, upc, price_cents, url, title, observed_at } = req.body || {};

  const storeNorm = String(store || '').trim();
  const upcNorm = normalizeKeyAsUPC(upc || null);
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
      if (!upcNorm) throw new Error('upc required for non Amazon stores');

      // Upsert listing by (store, upc). No unique constraint? Do UPDATE..INSERT pattern.
      const upd = await client.query(
        `UPDATE public.listings
            SET url = COALESCE($3, url), status = 'active'
          WHERE lower(btrim(store)) = lower(btrim($1))
            AND ${NORM_UPC_SQL('upc')} = ${NORM_UPC_SQL('$2')}`,
        [storeNorm, upcNorm, url || null]
      );

      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO public.listings (store, upc, url, status)
           VALUES ($1, $2, $3, 'active')`,
          [storeNorm, upcNorm, url || null]
        );
      }

      // Write observation; IMPORTANT: put UPC in price_history.store_sku so the trigger can match
      await client.query(
        `INSERT INTO public.price_history (store, store_sku, price_cents, observed_at, url, title)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)`,
        [storeNorm, upcNorm, cents, observed_at || null, url || null, title || null]
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

// Shutdown
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
