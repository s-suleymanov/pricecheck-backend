// server.js
// Express API for PriceCheck (Render + Neon)

const express = require('express');
const { Pool } = require('pg');
const app = express();

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- DB pool ---
// DATABASE_URL should point to your Neon connection string (prefer the pooler host)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Health ---
app.get('/health', (_req, res) => res.json({ ok: true, version: 'v10-notes' }));

// --- Utils ---
function normalizeStoreKey(store, key) {
  if (!key) return '';
  const s = String(store || '').toLowerCase();
  let k = String(key || '').trim();
  if (s === 'target') {
    k = k.replace(/^A[-\s]?/i, '');   // A-12345678 -> 12345678
    k = k.replace(/[^0-9A-Z]/g, '');  // keep digits/letters
  } else if (s === 'walmart' || s === 'bestbuy') {
    k = k.replace(/\D+/g, '');        // digits only
  }
  return k;
}

// =====================
//  /v1/resolve
//  Resolve ASIN from store + store_key using listings → asins
// =====================
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH variant_row AS (
        SELECT
          a.id AS variant_id,
          a.asin,
          p.title AS product_title,
          a.variant_label
        FROM public.asins a
        LEFT JOIN public.products p ON p.id = a.product_id
        WHERE upper(a.asin) = $1
      ),
      latest_listings AS (
        -- latest one per store for this ASIN
        SELECT DISTINCT ON (l.store)
          l.store,
          l.store_sku,
          l.url,
          l.price_cents,
          l.observed_at,
          l.notes
        FROM public.listings l
        JOIN public.asins a ON a.id = l.variant_id
        WHERE upper(a.asin) = $1
        ORDER BY l.store, l.observed_at DESC NULLS LAST, l.id DESC
      ),
      amazon_note AS (
        SELECT l.notes
        FROM public.listings l
        JOIN public.asins a ON a.id = l.variant_id
        WHERE lower(l.store) = 'amazon' AND upper(a.asin) = $1 AND l.notes IS NOT NULL
        ORDER BY l.observed_at DESC NULLS LAST, l.id DESC
        LIMIT 1
      )
      -- Amazon row (no price yet, just title/notes)
      SELECT
        'Amazon'::text AS store,
        (SELECT asin FROM variant_row LIMIT 1) AS asin,
        NULL::text AS store_sku,
        NULL::int AS price_cents,
        NULL::timestamptz AS observed_at,
        NULL::text AS url,
        COALESCE((SELECT product_title FROM variant_row LIMIT 1), '') AS title,
        (SELECT notes FROM amazon_note) AS notes

      UNION ALL

      -- Other stores
      SELECT
        ll.store,
        $1 AS asin,
        ll.store_sku,
        ll.price_cents,
        ll.observed_at,
        ll.url,
        NULL::text AS title,
        ll.notes
      FROM latest_listings ll

      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;

    const { rows } = await pool.query(sql, [asin]);

    res.json({
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title,   // Amazon row has title; others usually null
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


// =====================
//  /v1/compare
//  Build a compare list for one ASIN:
//    - Amazon row from asins (current price + observed_at)
//    - Latest row per store from listings (includes notes)
// =====================
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH the_variant AS (
        SELECT
          a.id AS variant_id,
          a.asin,
          p.title AS product_title,
          a.variant_label,
          a.current_price_cents AS amazon_price_cents,
          a.current_price_observed_at AS amazon_observed_at
        FROM public.asins a
        JOIN public.products p ON p.id = a.product_id
        WHERE upper(a.asin) = $1
      ),
      latest_listings AS (
        -- One latest listing per store for this variant (includes notes)
        SELECT DISTINCT ON (l.store)
          l.store,
          l.store_sku,
          l.url,
          l.current_price_cents AS price_cents,
          COALESCE(l.current_price_observed_at, l.observed_at) AS observed_at,
          l.notes
        FROM public.listings l
        JOIN the_variant v ON v.variant_id = l.variant_id
        ORDER BY l.store,
                 COALESCE(l.current_price_observed_at, l.observed_at) DESC NULLS LAST,
                 l.id DESC
      ),
      amazon_note AS (
        -- If you keep an Amazon listing row, use its latest note for the Amazon card too
        SELECT l.notes
        FROM public.listings l
        JOIN the_variant v ON v.variant_id = l.variant_id
        WHERE lower(l.store) = 'amazon' AND l.notes IS NOT NULL
        ORDER BY COALESCE(l.current_price_observed_at, l.observed_at) DESC NULLS LAST, l.id DESC
        LIMIT 1
      )
      SELECT
        'Amazon'::text AS store,
        v.asin,
        NULL::text AS store_sku,
        v.amazon_price_cents AS price_cents,
        v.amazon_observed_at AS observed_at,
        NULL::text AS url,
        COALESCE(v.product_title, '') AS title,
        (SELECT notes FROM amazon_note) AS notes
      FROM the_variant v

      UNION ALL

      SELECT
        ll.store,
        (SELECT asin FROM the_variant),
        ll.store_sku,
        ll.price_cents,
        ll.observed_at,
        ll.url,
        NULL::text AS title,
        ll.notes
      FROM latest_listings ll

      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;

    const { rows } = await pool.query(sql, [asin]);

    res.json({
      results: rows.map(r => ({
        store: r.store,
        product_name: r.title,       // only Amazon row has title here
        price_cents: r.price_cents,
        url: r.url,
        currency: 'USD',
        asin: r.asin,
        seen_at: r.observed_at,
        notes: r.notes || null       // <-- include notes
      }))
    });
  } catch (err) {
    console.error('compare error:', err);
    res.status(500).json({ results: [] });
  }
});

// --- Start / Stop ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));

process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
