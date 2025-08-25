// server.js - UPC Comparison API (SQLite)

// --- Imports ---
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// --- Basic Setup ---
const app = express();
const PORT = 4000; // The port our server will run on. Must match manifest.json.

// --- Middleware ---
// A simple CORS middleware to allow our extension (from any origin) to make requests.
// This is important for local development.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// --- Database Connection ---
// Resolve the absolute path to the database file to avoid any confusion.
const dbPath = path.resolve(__dirname, 'prices.db');
// Create a new database connection. The connection is opened automatically.
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error opening database file:", err.message);
  } else {
    console.log("✅ SUCCESS: Server is connected to SQLite database at:", dbPath);
  }
});

// --- API Endpoints ---
/**
 * GET /v1/compare
 * The main endpoint for the extension. It searches the database for a given UPC.
 * Query Parameters:
 * - upc: The 12 or 13-digit UPC to search for.
 * - (asin, title are included but not used in this version)
 * Returns a JSON object with a 'results' array.
 */
app.get('/v1/compare', (req, res) => {
  // Get the UPC from the query string and trim any whitespace.
  const upc = (req.query.upc || '').trim();
  // If no UPC is provided, return an empty array immediately.
  if (!upc) {
    return res.json({ results: [] });
  }

  // SQL query to find a product by its UPC.
  // Using CAST(upc AS TEXT) makes the comparison robust, avoiding text vs. number issues.
  const sql = `SELECT * FROM products WHERE CAST(upc AS TEXT) = ? LIMIT 1`;

  // Execute the query using db.get, which returns only the first matching row.
  // The '?' in the SQL is safely replaced by the 'upc' variable to prevent SQL injection.
  db.get(sql, [upc], (err, row) => {
    // If there's a database error, log it and send a 500 server error response.
    if (err) {
      console.error("Database query error:", err.message);
      return res.status(500).json({ results: [] });
    }
    // If no matching row is found, return an empty array.
    if (!row) {
      return res.json({ results: [] });
    }

    // If a row is found, format it into the standard response object.
    const item = {
      title: row.title,
      price_cents: row.price_cents,
      url: row.link,
      currency: "USD",
      store: row.store || "Unknown Store" // Default value if store is not set
    };
    // Send the formatted item back to the extension.
    res.json({ results: [item] });
  });
});

// --- Start Server ---
// Start listening for requests on the specified port.
app.listen(PORT, () => {
  console.log(`API server is up and running at http://localhost:${PORT}`);
});