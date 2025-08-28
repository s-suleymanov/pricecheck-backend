// content.js - Injects sidebar and scrapes product data

if (window.__PS_INJECTED__) {
  chrome.runtime?.onMessage.addListener((m) => { if (m?.type === "TOGGLE_SIDEBAR") PS.toggle(); });
} else {
  window.__PS_INJECTED__ = true;

  // ---------- utils ----------
  const hasChrome = () => typeof chrome !== "undefined" && chrome?.runtime?.id;
  const safeSet = async (kv) => { try { if (hasChrome()) await chrome.storage.local.set(kv); } catch {} };
  const safeSend = (msg) => new Promise((res) => {
    if (!hasChrome()) return res(null);
    try { chrome.runtime.sendMessage(msg, (r) => res(r)); } catch { res(null); }
  });
  const clean = (s = "") => s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/\s+/g, " ").trim();
  const extractUPC = (str) => {
    const m = clean(str).match(/(?:^|[^\d])(\d{12,13})(?!\d)/);
    if (!m) return null;
    let c = m[1];
    if (c.length === 13 && c.startsWith("0")) c = c.slice(1);
    return c.length === 12 ? c : null;
  };
  const getTitle = () =>
    clean(document.getElementById("productTitle")?.innerText ||
          document.querySelector("#title span")?.innerText || "") || null;
  const getASIN = () => {
    const fromUrl = location.pathname.match(/\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
    const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
    return (fromUrl || fromAttr || "").toUpperCase() || null;
  };

  // robust UPC finder on Amazon PDPs
  function findUPC() {
    const tableRowSelectors = [
      "#prodDetails tr",
      "table#productDetails_techSpec_section_1 tr",
      "table#productDetails_detailBullets_sections1 tr",
      "#technicalSpecifications_section_1 tr",
      "#poExpander tr"
    ];
    for (const sel of tableRowSelectors) {
      for (const tr of document.querySelectorAll(sel)) {
        const label = clean(tr.querySelector("th,.a-text-bold,.a-color-secondary,.label")?.innerText || tr.firstElementChild?.innerText || "");
        if (!/upc|ean|gtin/i.test(label)) continue;
        const valEl = tr.querySelector("td:last-child") || tr.querySelector("td") || tr;
        const upc = extractUPC(valEl.innerText);
        if (upc) return upc;
      }
    }
    const bulletSelectors = ["#detailBullets_feature_div li", "#detailBulletsWrapper_feature_div li", "#detailBulletsWrapper_feature_div span"];
    for (const sel of bulletSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const txt = clean(el.innerText);
        if (/upc|ean|gtin/i.test(txt)) {
          const upc = extractUPC(txt);
          if (upc) return upc;
        }
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = clean(node.nodeValue || "");
      if (!/upc/i.test(t)) continue;
      let upc = extractUPC(t) || extractUPC(node.parentElement?.innerText || "");
      if (upc) return upc;
      const row = node.parentElement?.closest("tr,li,div,span,td,th");
      if (row) {
        upc = extractUPC(row.innerText) ||
              extractUPC(row.querySelector("td + td, th + td")?.innerText || "") ||
              extractUPC(row.nextElementSibling?.innerText || "");
        if (upc) return upc;
      }
    }
    return null;
  }

  // ---------- sidebar UI (inline, no external files) ----------
  const INLINE_HTML = `
<div class="panel">
  <div class="resize" id="ps-resize"></div>
  <div class="header">
    <div>
      <div class="title">PriceCheck</div>
      <div class="subtitle">Comparison Tool</div>
    </div>
    <button id="ps-close" class="xbtn" title="Close">×</button>
  </div>
  <div class="content">
    <div class="card">
      <div class="section-title">Current Product</div>
      <div class="kv">Title: <span id="ps-title">Loading...</span></div>
      <div class="kv">UPC: <span id="ps-upc">Loading...</span></div>
      <div class="kv">ASIN: <span id="ps-asin">Loading...</span></div>
    </div>
    <div class="card">
      <div class="section-title" style="margin:0 0 8px 0;">Comparison Results</div>
      <div id="ps-results"><div class="status" id="ps-status">Searching...</div></div>
    </div>
  </div>
</div>`;

  const INLINE_CSS = `
:host { all: initial; }
.panel {
  box-sizing: border-box; height: 100vh; width: 100%;
  background: #f9f9f9; border-right: 1px solid #ddd;
  font: 14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  color: #111; display: flex; flex-direction: column; position: relative;
}
.header {
  background: #fff; border-bottom: 1px solid #e0e0e0;
  padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
}
.title { font-size: 16px; font-weight: 700; margin: 0; }
.subtitle { font-size: 12px; color: #666; margin: 2px 0 0; }
.content { padding: 16px; overflow: auto; }
.section-title { font-weight: 600; color: #555; margin-bottom: 8px; text-transform: uppercase; font-size: 12px; }
.card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; }
.card + .card { margin-top: 16px; }
.kv { margin: 4px 0; } .kv span { font-weight: 600; }
.result-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.result-item:last-child { border-bottom: none; }
.store-name { font-weight: 600; }
.price { font-size: 16px; font-weight: 700; color: #0a8f00; }
.link { color: #06c; text-decoration: none; font-size: 13px; }
.link:hover { text-decoration: underline; }
.status { color: #888; text-align: center; padding: 20px; }
.xbtn { border: 0; background: transparent; font-size: 30px; cursor: pointer; }
.resize { position: absolute; right: -6px; top: 0; width: 6px; height: 100%; cursor: ew-resize; }`;

  const PS = {
    id: "pricecheck-sidebar-root",
    width: 380,
    open: false,
    root: null,
    shadow: null,

    // create shadow UI synchronously from inline HTML+CSS
    async ensure() {
      if (this.root) return this.root;
      const root = document.createElement("div");
      root.id = this.id;
      root.style.all = "initial";
      root.style.position = "fixed";
      root.style.top = "0";
      root.style.left = "0";
      root.style.height = "100%";
      root.style.width = this.width + "px";
      root.style.zIndex = "2147483647";
      root.style.display = "none";
      document.documentElement.appendChild(root);

      const sh = root.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = INLINE_CSS;
      const container = document.createElement("div");
      container.innerHTML = INLINE_HTML;
      sh.appendChild(style);
      sh.appendChild(container);

      // wire controls
      sh.querySelector("#ps-close")?.addEventListener("click", () => this.close());
      let resizing = false;
      sh.querySelector("#ps-resize")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
        resizing = true;
        document.documentElement.style.cursor = "ew-resize";
      });
      window.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        const w = Math.min(Math.max(300, e.clientX), Math.min(700, window.innerWidth - 120));
        this.width = w; root.style.width = w + "px"; this.applyPagePush();
      });
      window.addEventListener("mouseup", () => { resizing = false; document.documentElement.style.cursor = ""; });

      this.root = root; this.shadow = sh;
      return root;
    },

    applyPagePush() {
      const html = document.documentElement; const body = document.body;
      if (!html.style.transition) html.style.transition = "margin-left 160ms ease";
      if (!body.style.transition) body.style.transition = "margin-left 160ms ease";
      const v = this.open ? this.width + "px" : "";
      html.style.marginLeft = v; body.style.marginLeft = v;
    },

    async populate() {
      const sh = this.shadow;
      const $ = (sel) => (sh ? sh.querySelector(sel) : null);

      const snap = { title: getTitle(), upc: findUPC(), asin: getASIN() };
      await safeSet({ lastSnapshot: snap });

      const titleEl = $("#ps-title");
      const upcEl   = $("#ps-upc");
      const asinEl  = $("#ps-asin");
      if (titleEl) titleEl.textContent = snap.title ? snap.title.slice(0, 80) : "N/A";
      if (upcEl)   upcEl.textContent   = snap.upc || "Not found on page";
      if (asinEl)  asinEl.textContent  = snap.asin || "N/A";

      const statusEl  = $("#ps-status");
      const resultsEl = $("#ps-results");
      if (!statusEl || !resultsEl) return;

      if (!snap.upc) {
        statusEl.textContent = "UPC not found on this page.";
        return;
      }

      statusEl.textContent = "Searching...";
      const resp = await safeSend({ type: "COMPARE_REQUEST", payload: { upc: snap.upc, asin: snap.asin, title: snap.title } });
      const list = Array.isArray(resp?.results) ? resp.results : [];

      resultsEl.innerHTML = "";
      if (!list.length) {
        statusEl.textContent = "No matches found.";
        return;
      }

      for (const p of list) {
        const item = document.createElement("div");
        item.className = "result-item";
        item.innerHTML = `
          <div>
            <div class="store-name">${p.store || ""}</div>
            <a href="${p.url}" target="_blank" rel="noopener" class="link">View Product</a>
          </div>
          <div class="price">${p.price_cents != null ? "$" + (p.price_cents / 100).toFixed(2) : "N/A"}</div>
        `;
        resultsEl.appendChild(item);
      }
      statusEl.textContent = "";
    },

    async openSidebar() {
      await this.ensure();
      this.open = true;
      this.root.style.display = "block";
      this.root.style.width = this.width + "px";
      this.applyPagePush();
      await this.populate();
    },
    close() {
      if (!this.root) return;
      this.open = false;
      this.root.style.display = "none";
      this.applyPagePush();
    },
    toggle() { this.open ? this.close() : this.openSidebar(); }
  };

  // init
  window.PS = PS;
  chrome.runtime?.onMessage.addListener((m) => { if (m?.type === "TOGGLE_SIDEBAR") PS.toggle(); });

  const mo = new MutationObserver(() => {
    if (PS.open) {
      clearTimeout(mo._t);
      mo._t = setTimeout(() => PS.populate(), 600);
    }
  });
  mo.observe(document, { childList: true, subtree: true });

  window.addEventListener("pageshow", (e) => { if (e.persisted && PS.open) { PS.applyPagePush(); PS.populate(); } });
}
