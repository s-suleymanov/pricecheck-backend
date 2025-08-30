// server.js - UPC Comparison API (PostgreSQL)

const express = require('express');
// --- NEW: Import the Pool object from the pg library ---
const { Pool } = require('pg');

// --- Basic Setup ---
// --- NEW: Use Render's port, or fallback to 4000 for local dev ---
const PORT = process.env.PORT || 4000;

// --- Middleware ---
// Simple CORS middleware, unchanged.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// --- NEW: PostgreSQL Database Connection ---
// The Pool will automatically find and use the DATABASE_URL
// environment variable when you deploy on Render.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // This is required for connecting to Render databases
  ssl: {
    rejectUnauthorized: false
  }
});

console.log("✅ SUCCESS: Server is configured to connect to PostgreSQL.");

// --- API Endpoints (Updated with async/await) ---
/**
 * GET /v1/compare
 * Searches the PostgreSQL database for a given UPC.
 */
app.get('/v1/compare', async (req, res) => {
  const upc = (req.query.upc || '').trim();
  if (!upc) {
    return res.json({ results: [] });
  }

  // --- NEW: PostgreSQL query syntax ---
  // We use $1 as a placeholder instead of ?.
  const sql = `SELECT * FROM products WHERE upc = $1 LIMIT 1`;
  const params = [upc];

  try {
    // --- NEW: Modern async/await query execution ---
    const { rows } = await pool.query(sql, params);
    const row = rows[0]; // Get the first result

    if (!row) {
      return res.json({ results: [] });
    }

    // Format the item, just like before.
    const item = {
      title: row.title,
      price_cents: row.price_cents,
      url: row.link,
      currency: "USD",
      store: row.store || "Unknown Store"
    };

    res.json({ results: [item] });
  } catch (err) {
    console.error("Database query error:", err.message);
    return res.status(500).json({ results: [] });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`API server is up and running on port ${PORT}`);
});

