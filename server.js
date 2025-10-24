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

// ---- helpers ----
function normUPC(val) {
  if (!val) return '';
  let k = String(val).replace(/[^0-9]/g, '');
  if (k.length === 13 && k.startsWith('0')) k = k.slice(1);
  return k;
}
function normStore(s) {
  return String(s || '').trim().toLowerCase();
}
function toASIN(s) {
  s = String(s || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s) ? s : '';
}

// Health
app.get('/health', (_req, res) => res.json({ ok: true, version: 'v-upc-fast' }));

// ==================== UPC -> ASIN Resolve (single indexed lookup) ====================
app.get('/v1/resolve', async (req, res) => {
  const storeNorm = normStore(req.query.store);
  const upcNorm = normUPC(req.query.store_key);
  if (!storeNorm || !upcNorm) return res.json({ asin: null });

  try {
    // Prefer ASIN mapped by UPC in asins, else use listings.asin
    const sql = `
      SELECT COALESCE(
        (SELECT asin_up FROM public.asins    WHERE upc_norm = $2 LIMIT 1),
        (SELECT asin_up FROM public.listings WHERE store_norm = $1 AND upc_norm = $2 AND asin_up IS NOT NULL
           ORDER BY current_price_observed_at DESC NULLS LAST, id DESC LIMIT 1)
      ) AS asin_up
    `;
    const { rows } = await pool.query(sql, [storeNorm, upcNorm]);
    const asin = rows[0]?.asin_up || null;
    return res.json({ asin });
  } catch (e) {
    console.error('resolve error:', e);
    return res.json({ asin: null });
  }
});

// ==================== Compare by UPC (one round trip) ====================
app.get('/v1/compare_by_upc', async (req, res) => {
  const storeNorm = normStore(req.query.store);
  const upcNorm = normUPC(req.query.upc);
  if (!storeNorm || !upcNorm) return res.json({ asin: null, results: [] });

  try {
    const sql = `
      WITH v AS (
        -- Try to anchor on ASIN by UPC first
        SELECT a.asin_up AS asin, a.upc_norm AS upc_norm, a.variant_label,
               a.current_price_cents AS amazon_price_cents,
               a.current_price_observed_at AS amazon_observed_at,
               p.title AS product_title, p.brand, p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE a.upc_norm = $1
         LIMIT 1
      ),
      v2 AS (
        -- If asins has no row for that UPC, derive ASIN from listings
        SELECT COALESCE(
                 (SELECT asin FROM v),
                 (SELECT l.asin_up FROM public.listings l
                   WHERE l.upc_norm = $1 AND l.asin_up IS NOT NULL
                   ORDER BY l.current_price_observed_at DESC NULLS LAST, l.id DESC LIMIT 1)
               ) AS asin
      ),
      vfit AS (
        SELECT
          v2.asin,
          a.upc_norm,
          a.variant_label,
          a.current_price_cents AS amazon_price_cents,
          a.current_price_observed_at AS amazon_observed_at,
          p.title AS product_title, p.brand, p.category
        FROM v2
        LEFT JOIN public.asins a ON a.asin_up = v2.asin
        LEFT JOIN public.products p ON p.id = a.product_id
      ),
      match_upc AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN vfit ON l.upc_norm = COALESCE(vfit.upc_norm, $1)  -- match same UPC
      ),
      match_asin AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN vfit ON l.asin_up = vfit.asin
      ),
      chosen AS (
        SELECT * FROM match_upc
        UNION ALL
        SELECT * FROM match_asin
        WHERE NOT EXISTS (SELECT 1 FROM match_upc LIMIT 1)
      )
      SELECT
        'Amazon'::text AS store,
        vfit.asin,
        vfit.upc_norm AS upc,
        vfit.amazon_price_cents AS price_cents,
        vfit.amazon_observed_at AS observed_at,
        NULL::text AS url,
        vfit.product_title AS title,
        vfit.brand,
        vfit.category,
        vfit.variant_label
      FROM vfit

      UNION ALL

      SELECT
        c.store,
        vfit.asin,
        (SELECT upc_norm FROM vfit) AS upc,
        c.price_cents,
        c.observed_at,
        c.url,
        (SELECT product_title FROM vfit) AS title,
        NULL::text AS brand,
        NULL::text AS category,
        NULL::text AS variant_label
      FROM chosen c

      ORDER BY price_cents ASC NULLS LAST, store ASC
    `;
    const { rows } = await pool.query(sql, [upcNorm]);

    const asin = rows.find(r => r.store === 'Amazon')?.asin || null;
    res.json({
      asin: asin || null,
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title || '',
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin || null,
        upc: r.upc || null,
        seen_at: r.observed_at,
        brand: r.brand || null,
        category: r.category || null,
        variant_label: r.variant_label || null
      }))
    });
  } catch (e) {
    console.error('compare_by_upc error:', e);
    res.status(500).json({ asin: null, results: [] });
  }
});

// ==================== Compare by ASIN (unchanged contract, faster predicates) ====================
app.get('/v1/compare', async (req, res) => {
  const asin = toASIN(req.query.asin);
  if (!asin) return res.json({ results: [] });

  try {
    const sql = `
      WITH v AS (
        SELECT a.asin_up AS asin,
               a.upc_norm,
               a.variant_label,
               a.current_price_cents AS amazon_price_cents,
               a.current_price_observed_at AS amazon_observed_at,
               p.title AS product_title,
               p.brand,
               p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE a.asin_up = $1
         LIMIT 1
      ),
      match_upc AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN v ON l.upc_norm = v.upc_norm
      ),
      match_asin AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN v ON l.asin_up = v.asin
      ),
      chosen AS (
        SELECT * FROM match_upc
        UNION ALL
        SELECT * FROM match_asin
        WHERE NOT EXISTS (SELECT 1 FROM match_upc LIMIT 1)
      )
      SELECT
        'Amazon'::text AS store,
        v.asin,
        v.upc_norm AS upc,
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

      ORDER BY price_cents ASC NULLS LAST, store ASC
    `;
    const { rows } = await pool.query(sql, [asin]);

    res.json({
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title || '',
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin || null,
        upc: r.upc || null,
        seen_at: r.observed_at,
        brand: r.brand || null,
        category: r.category || null,
        variant_label: r.variant_label || null
      }))
    });
  } catch (e) {
    console.error('compare error:', e);
    res.status(500).json({ results: [] });
  }
});

// ==================== Observe (uses normalized columns implicitly) ====================
app.post('/v1/observe', async (req, res) => {
  const { store, asin, upc, price_cents, url, title, observed_at } = req.body || {};
  const storeNorm = normStore(store);
  const cents = Number.isFinite(price_cents) ? price_cents : null;

  if (!storeNorm || !Number.isFinite(cents)) {
    return res.status(400).json({ ok: false, error: 'store and price_cents required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (storeNorm === 'amazon') {
      const asinUp = toASIN(asin);
      if (!asinUp) throw new Error('asin required for Amazon');

      await client.query(
        `INSERT INTO public.asins (product_id, asin)
         VALUES (NULL, $1) ON CONFLICT (asin_up) DO NOTHING`,
        [asinUp]
      );

      await client.query(
        `INSERT INTO public.price_history (store, asin, price_cents, observed_at, url, title)
         VALUES ('Amazon', $1, $2, COALESCE($3::timestamptz, now()), $4, $5)`,
        [asinUp, cents, observed_at || null, url || null, title || null]
      );
    } else {
      const upcNorm = normUPC(upc);
      if (!upcNorm) throw new Error('upc required for non Amazon stores');

      // Upsert listing by normalized keys
      const upd = await client.query(
        `UPDATE public.listings
            SET url = COALESCE($3, url), status = 'active'
          WHERE store_norm = $1 AND upc_norm = $2`,
        [storeNorm, upcNorm, url || null]
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO public.listings (store, upc, url, status)
           VALUES ($1, $2, $3, 'active')`,
          [store, upcNorm, url || null]
        );
      }

      await client.query(
        `INSERT INTO public.price_history (store, upc, price_cents, observed_at, url, title)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)`,
        [store, upcNorm, cents, observed_at || null, url || null, title || null]
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

process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
