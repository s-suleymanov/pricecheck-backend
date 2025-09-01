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
  
  // --- CORRECTED: Use the correct method to get the icon's full URL ---
  const TARGET_ICON_URL = chrome.runtime.getURL('icons/target-circle.png');
  const LOGO_ICON_URL = chrome.runtime.getURL('icons/logo.png')

  const INLINE_HTML = `
<div class="panel">
  <div class="resize" id="ps-resize"></div>
    <!-- Find the existing <div class="header">...</div> and replace it with this -->
  <div class="header">
    <div class="header-left">
      <div class="header-icon"><img src="${LOGO_ICON_URL}" alt="PriceCheck Logo"></div>
      <div>
        <div class="title">PriceCheck</div>
        <div class="subtitle">Comparison Tool</div>
      </div>
    </div>
    <button id="ps-close" class="xbtn" title="Close">×</button>
  </div>
  <div class="content">
    <div class="section-title">Current Product</div>
    <div class="card">
      <div class="kv"> <span id="ps-title">Loading...</span></div>
      <div class="kv">UPC: <span id="ps-upc">Loading...</span></div>
      <div class="kv">ASIN: <span id="ps-asin">Loading...</span></div>
    </div>
    <div class="section-title" style="margin:16px 0 8px 0;">Comparison Results</div>
    <div class="card">
      <div id="ps-results"><div class="status" id="ps-status">Searching...</div></div>
    </div>
  </div>

  <div class="footer">
    <span class="footer-version">Version Beta</span>
    <div class="footer-separator"></div>
    <a href="mailto:pricecheckextension@gmail.com" class="footer-support">Contact Me</a>
  </div>
</div>`;

  const INLINE_CSS = `
:host { all: initial; }
.panel {
  box-sizing: border-box; height: 100vh; width: 100%;
  background: #f9f9f9; border-right: 1px solid #ddd;
  font: 16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  color: #111; display: flex; flex-direction: column; position: relative;
}
.header {
  background: #fff; border-bottom: 1px solid #e0e0e0;
  padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
}
.title { font-size: 20px; font-weight: 700; margin: 0; }
.subtitle { font-size: 14px; color: #666; margin: 0 0 0; }
.content { padding: 16px; overflow: auto; flex-grow: 1; }
.section-title { font-weight: 600; color: #555; margin-bottom: 8px; text-transform: uppercase; font-size: 12px; }
.card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; }
.card + .card { margin-top: 16px; }
.kv { margin: 4px 0; } .kv span { font-weight: 600; }
.result-item { display: block; padding: 0 0; border-bottom: 1px solid #f0f0f0; }
.result-item:last-child { border-bottom: none; }
.store-name { font-weight: 600; }
.price { font-size: 16px; font-weight: 700; color: #0a8f00; }
.link { color: #06c; text-decoration: none; font-size: 14px; }
.link:hover { text-decoration: underline; }
.status { color: #888; text-align: center; padding: 20px; }
.xbtn { border: 0; background: transparent; font-size: 30px; cursor: pointer; }
.resize { position: absolute; right: -6px; top: 0; width: 6px; height: 100%; cursor: ew-resize; }
.result-main { display: flex; align-items: center; justify-content: space-between; }
.store-details { display: flex; align-items: center; }
.store-text { display: flex; flex-direction: column; }
.store-name { font-size: 18px; margin-bottom: 2px; }
.price { font-size: 20px; } 
.disclaimer {
  font-style: italic;
  font-size: 14px;
  color: #888;
  text-align: center;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid #f0f0f0;
}
.store-icon { display: flex;}
.store-icon img { width: 36px; height: 36px; margin-right: 8px; }
.header-left { display: flex; align-items: center; }
.header-icon { display: flex; align-items: center; margin-right: 12px; }
.header-icon img { width: 32px; height: 32px; }
.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  background: #fff;
  border-top: 1px solid #e0e0e0;
  font-size: 16px;
  color: #888;
}
.footer-separator {
  width: 1px;
  height: 14px;
  background-color: #ddd;
  margin: 0 10px;
}
.footer-support {
  color: #06c;
  text-decoration: none;
}
.footer-support:hover {
  text-decoration: underline;
}
`;

  const PS = {
    id: "pricecheck-sidebar-root",
    width: 380,
    open: false,
    root: null,
    shadow: null,

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
      const html = document.documentElement;
      const body = document.body;
      const on = this.open;
      const pad = on ? this.width + "px" : "";

      // animate only the body
      if (!body.style.transition) body.style.transition = "padding-left 160ms ease";

      // clear any previous pushes on <html>
      html.style.paddingLeft = "";
      html.style.marginLeft  = "";
      html.style.overflowX   = "";

      // push the page by padding the body
      body.style.paddingLeft = pad;

      // prevent bottom scrollbar while open
      body.style.overflowX   = on ? "hidden" : "";

      // remove the default UA 8px body margin while open, so no sliver remains
      body.style.margin      = on ? "0" : "";
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

      const resultsEl = $("#ps-results");
      if (!resultsEl) return;
      
      resultsEl.innerHTML = `<div class="status">Searching...</div>`;

      if (!snap.upc) {
        resultsEl.innerHTML = `<div class="status">UPC not found on this page.</div>`;
        return;
      }

      const resp = await safeSend({ type: "COMPARE_REQUEST", payload: { upc: snap.upc, asin: snap.asin, title: snap.title } });
      const list = Array.isArray(resp?.results) ? resp.results : [];

      if (!list.length) {
        resultsEl.innerHTML = `<div class="status">No product found.</div>`;
        return;
      }

      resultsEl.innerHTML = "";
      for (const p of list) {
        const item = document.createElement("div");
        item.className = "result-item";
        // Replace the old item.innerHTML with this new version
        item.innerHTML = `
          <div class="result-main">
            <div class="store-details">
              <div class="store-icon"><img src="${TARGET_ICON_URL}" alt="Store Logo"></div>
              <div class="store-text">
                <div class="store-name">${p.store || "Target"}</div>
                <a href="${p.url}" target="_blank" rel="noopener" class="link">View Product</a>
              </div>
            </div>
            <div class="price">${p.price_cents != null ? "$" + (p.price_cents / 100).toFixed(2) : "N/A"}</div>
          </div>
          <div class="disclaimer">
            Delivery & handling fees not included.
          </div>
        `;
        resultsEl.appendChild(item);
      }
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

