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

app.get('/health', (_req, res) => res.json({ ok: true, version: 'v-upc-rev-fixed' }));

// ==================== Resolve: UPC -> ASIN ====================
// Uses your expression indexes only: upper(btrim(asin)) and norm_upc(upc)
app.get('/v1/resolve', async (req, res) => {
  const storeNorm = normStore(req.query.store); // not used right now, kept for future branch logic
  const upcNorm = normUPC(req.query.store_key);
  if (!upcNorm) return res.json({ asin: null });

  try {
    const sql = `
      SELECT upper(btrim(asin)) AS asin
      FROM public.asins
      WHERE public.norm_upc(upc) = public.norm_upc($1)
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [upcNorm]);
    const asin = rows[0]?.asin || null;
    return res.json({ asin });
  } catch (e) {
    console.error('resolve error:', e);
    return res.json({ asin: null });
  }
});

// ==================== Compare by UPC ====================
// Returns Amazon price if known plus all store listings with that UPC
app.get('/v1/compare_by_upc', async (req, res) => {
  let upc = normUPC(req.query.upc);
  if (!upc) return res.json({ asin: null, results: [] });

  try {
    const r1 = await pool.query(
      `SELECT upper(btrim(a.asin)) AS asin,
              a.variant_label,
              a.current_price_cents AS amazon_price_cents,
              a.current_price_observed_at AS amazon_observed_at,
              p.title, p.brand, p.category
         FROM public.asins a
         LEFT JOIN public.products p ON p.id = a.product_id
        WHERE public.norm_upc(a.upc) = public.norm_upc($1)
        LIMIT 1`,
      [upc]
    );
    const A = r1.rows[0] || null;
    const asin = A?.asin || null;

    const r2 = await pool.query(
      `SELECT store,
              upc,
              url,
              current_price_cents AS price_cents,
              current_price_observed_at AS observed_at
         FROM public.listings
        WHERE public.norm_upc(upc) = public.norm_upc($1)
        ORDER BY price_cents ASC NULLS LAST, store ASC`,
      [upc]
    );

    const out = [];
    if (A) {
      out.push({
        store: 'Amazon',
        asin,
        upc,
        price_cents: A.amazon_price_cents,
        seen_at: A.amazon_observed_at,
        url: asin ? `https://www.amazon.com/dp/${asin}` : null,
        product_name: A.title || '',
        brand: A.brand || null,
        category: A.category || null,
        variant_label: A.variant_label || null,
        currency: 'USD'
      });
    }
    for (const r of r2.rows) {
      out.push({
        store: r.store,
        asin,
        upc,
        price_cents: r.price_cents,
        seen_at: r.observed_at,
        url: r.url,
        product_name: A?.title || '',
        brand: null,
        category: null,
        variant_label: null,
        currency: 'USD'
      });
    }

    res.json({ asin, results: out });
  } catch (e) {
    console.error('compare_by_upc error:', e);
    res.status(500).json({ asin: null, results: [] });
  }
});

// ==================== Compare by ASIN ====================
// Joins Amazon row and any store listings that share the same UPC
app.get('/v1/compare', async (req, res) => {
  const asin = toASIN(req.query.asin);
  if (!asin) return res.json({ results: [] });

  try {
    const sql = `
      WITH v AS (
        SELECT upper(btrim(a.asin)) AS asin,
               public.norm_upc(a.upc) AS upc_norm,
               a.variant_label,
               a.current_price_cents AS amazon_price_cents,
               a.current_price_observed_at AS amazon_observed_at,
               p.title AS product_title,
               p.brand,
               p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE upper(btrim(a.asin)) = $1
         LIMIT 1
      ),
      match_upc AS (
        SELECT l.store, l.upc, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at
          FROM public.listings l
          JOIN v ON public.norm_upc(l.upc) = v.upc_norm
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
        m.store,
        (SELECT asin FROM v),
        m.upc,
        m.price_cents,
        m.observed_at,
        m.url,
        (SELECT product_title FROM v) AS title,
        NULL::text AS brand,
        NULL::text AS category,
        NULL::text AS variant_label
      FROM match_upc m

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

// ==================== Observe price ====================
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

     // create ASIN row if missing, using your expression unique index
    await client.query(
      `INSERT INTO public.asins (product_id, asin)
      SELECT NULL, $1
      WHERE NOT EXISTS (
        SELECT 1 FROM public.asins
        WHERE upper(btrim(asin)) = upper(btrim($1))
      )`,
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

      // Update by expression match first
      const upd = await client.query(
        `UPDATE public.listings
            SET url = COALESCE($3, url), status = 'active'
          WHERE lower(btrim(store)) = lower(btrim($1))
            AND public.norm_upc(upc) = public.norm_upc($2)`,
        [store, upcNorm, url || null]
      );
      if (upd.rowCount === 0) {
        // Insert new listing. We cannot ON CONFLICT on an expression, so rely on prior update to dedupe.
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
