app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return res.json({ results: [] });

  try {
    const sql = `
      WITH input_variant AS (
        SELECT a.asin,
               a.upc,
               a.id AS asin_row_id,
               a.variant_label,
               a.current_price_cents  AS amazon_price_cents,
               a.current_price_observed_at AS amazon_observed_at,
               p.title AS product_title,
               p.brand,
               p.category
          FROM public.asins a
          LEFT JOIN public.products p ON p.id = a.product_id
         WHERE upper(a.asin) = $1
         LIMIT 1
      ),

      -- First try to use UPC to gather other stores
      other_via_upc AS (
        SELECT l.store, l.store_sku, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at,
               l.title, l.status,
               l.upc
          FROM public.listings l
          JOIN input_variant v ON v.upc IS NOT NULL AND l.upc = v.upc
      ),

      -- If UPC did not find anything, fall back to ASIN joins
      other_via_asin AS (
        SELECT l.store, l.store_sku, l.url,
               l.current_price_cents AS price_cents,
               l.current_price_observed_at AS observed_at,
               l.title, l.status,
               l.upc
          FROM public.listings l
          JOIN input_variant v ON l.asin = v.asin
      ),

      other_stores AS (
        SELECT * FROM other_via_upc
        UNION ALL
        SELECT * FROM other_via_asin
        WHERE NOT EXISTS (SELECT 1 FROM other_via_upc LIMIT 1)
      )

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
        v.variant_label,
        NULL::text AS notes
      FROM input_variant v
      WHERE v.amazon_price_cents IS NOT NULL

      UNION ALL

      SELECT
        o.store,
        (SELECT asin FROM input_variant),
        o.store_sku,
        o.price_cents,
        o.observed_at,
        o.url,
        COALESCE(o.title, (SELECT product_title FROM input_variant)),
        NULL::text AS brand,
        NULL::text AS category,
        NULL::text AS variant_label,
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
