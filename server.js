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
function normalizeKeyAsUPC(key) {
  if (!key) return '';
  let k = String(key).replace(/[^0-9]/g, '');
  if (k.length === 13 && k.startsWith('0')) k = k.slice(1);
  return k;
}

app.get('/health', (_req, res) =>
  res.json({ ok: true, version: 'v-fast-compare-only' })
);

// ===== Compare by UPC: single hop, index-friendly
app.get('/v1/compare_by_upc', async (req, res) => {
  const store = String(req.query.store || '').trim();
  const upcNorm = normalizeKeyAsUPC(req.query.upc || '');
  if (!store || !upcNorm) return res.json({ asin: null, results: [] });

  try {
    const sql = `
      WITH v AS (
        SELECT a.asin,
               a.upc,
               a.current_price_cents        AS amazon_price_cents,
               a.current_price_observed_at  AS amazon_observed_at,
               p.title                      AS product_title,
               p.brand, p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE public.norm_upc(a.upc) = public.norm_upc($1::text)
         LIMIT 1
      ),
      xs AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
         WHERE public.norm_upc(l.upc) = public.norm_upc($1::text)
      )
      SELECT
        'Amazon'::text AS store,
        v.asin, v.upc,
        v.amazon_price_cents AS price_cents,
        v.amazon_observed_at AS observed_at,
        NULL::text AS url,
        v.product_title AS title,
        v.brand, v.category
      FROM v
      WHERE v.amazon_price_cents IS NOT NULL

      UNION ALL

      SELECT
        xs.store,
        (SELECT asin FROM v), xs.upc,
        xs.price_cents, xs.observed_at, xs.url,
        (SELECT product_title FROM v),
        NULL::text, NULL::text
      FROM xs

      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;
    const { rows } = await pool.query(sql, [upcNorm]);
    const asin = rows.find(r => r.store === 'Amazon')?.asin || null;
    res.json({
      asin: asin ? String(asin).toUpperCase() : null,
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title || '',
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin,
        upc: r.upc ?? null,
        seen_at: r.observed_at,
        brand: r.brand || null,
        category: r.category || null
      }))
    });
  } catch (err) {
    console.error('compare_by_upc error:', err);
    res.status(500).json({ asin: null, results: [] });
  }
});

// ===== Compare: ASIN -> cross-store prices (fast)
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH v AS (
        SELECT a.asin,
               a.upc,
               a.current_price_cents        AS amazon_price_cents,
               a.current_price_observed_at  AS amazon_observed_at,
               p.title                      AS product_title,
               p.brand, p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE upper(a.asin) = $1::text
         LIMIT 1
      ),
      match_upc AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN v ON public.norm_upc(l.upc) = public.norm_upc(v.upc)
      ),
      match_asin AS (
        SELECT l.store, l.upc, l.url,
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
      SELECT
        'Amazon'::text AS store,
        v.asin, v.upc,
        v.amazon_price_cents AS price_cents,
        v.amazon_observed_at AS observed_at,
        NULL::text AS url,
        v.product_title AS title,
        v.brand, v.category
      FROM v
      WHERE v.amazon_price_cents IS NOT NULL

      UNION ALL

      SELECT
        c.store,
        (SELECT asin FROM v), c.upc,
        c.price_cents, c.observed_at, c.url,
        (SELECT product_title FROM v),
        NULL::text, NULL::text
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
        upc: r.upc ?? null,
        seen_at: r.observed_at,
        brand: r.brand || null,
        category: r.category || null
      }))
    });
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ results: [] });
  }
});

// ===== Observe: price snapshot (unchanged, minimal)
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
         VALUES (NULL, $1::text)
         ON CONFLICT (asin) DO NOTHING`,
        [asinUp]
      );

      await client.query(
        `INSERT INTO public.price_history (store, asin, price_cents, observed_at, url, title)
         VALUES ('Amazon', $1::text, $2, COALESCE($3::timestamptz, now()), $4::text, $5::text)`,
        [asinUp, cents, observed_at || null, url || null, title || null]
      );

    } else {
      if (!upcNorm) throw new Error('upc required for non Amazon stores');

      const upd = await client.query(
        `UPDATE public.listings
            SET url = COALESCE($3::text, url), status = 'active'
          WHERE lower(btrim(store)) = lower(btrim($1::text))
            AND public.norm_upc(upc) = public.norm_upc($2::text)`,
        [storeNorm, upcNorm, url || null]
      );

      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO public.listings (store, upc, url, status)
           VALUES ($1::text, $2::text, $3::text, 'active')`,
          [storeNorm, upcNorm, url || null]
        );
      }

      await client.query(
        `INSERT INTO public.price_history (store, upc, price_cents, observed_at, url, title)
         VALUES ($1::text, $2::text, $3, COALESCE($4::timestamptz, now()), $5::text, $6::text)`,
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
