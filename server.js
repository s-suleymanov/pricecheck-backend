app.get('/v1/compare', async (req, res) => {
  const upc = String(req.query.upc || '').trim();
  if (!upc) return res.json({ results: [] });

  try {
    const { rows } = await pool.query(
      `
      SELECT upc, title, price_cents, url, store
      FROM products
      WHERE upc = $1
      ORDER BY price_cents ASC NULLS LAST
      LIMIT 1
      `,
      [upc]
    );

    if (rows.length === 0) return res.json({ results: [] });

    const r = rows[0] || {};
    const item = {
      upc: r.upc || upc,
      title: r.title || '',
      // ensure both names are present in JSON
      url: r.url || '',
      link: r.url || '',
      price_cents: r.price_cents ?? null,
      store: r.store || 'Unknown Store',
      currency: 'USD'
    };

    // helpful debug while you verify
    console.log('compare item:', item);

    return res.json({ results: [item] });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ results: [] });
  }
});
