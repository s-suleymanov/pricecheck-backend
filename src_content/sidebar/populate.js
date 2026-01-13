    export async function populate() {
    if (!this.shadow) return;

    if (this.isPopulating) return;
    this.isPopulating = true;

    const seq = ++this.populateSeq;

    try {
        const sh = this.shadow;
        const root = this.container || sh; // <--- key fix
        const site = siteOf();

        // Footer spacing: only when the page actually has horizontal overflow
        {
        const footer =
            root.querySelector("#ps-footer") ||
            root.querySelector(".footer") ||
            root.querySelector("#ps-footer-link")?.parentElement;

        if (footer) {
            const hasXOverflow =
            Math.ceil(document.documentElement.scrollWidth) >
            Math.ceil(document.documentElement.clientWidth);

            footer.style.marginBottom = (site === "amazon" && hasXOverflow) ? "15px" : "";
        }
        }

        const D = DRIVERS[site] || DRIVERS.amazon;

        const snap = {
        title: D.getTitle(),
        asin: D.getASIN ? D.getASIN() : null,
        price_cents: D.getPriceCents ? D.getPriceCents() : null,
        store_sku: D.getStoreSKU ? D.getStoreSKU() : null,
        };

        // Observe price (fire-and-forget)
        {
        const price = snap.price_cents;
        const key = this.observeKey(site, snap);

        const storeSkuForObserve = site === "amazon"
            ? String(snap.asin || "").trim().toUpperCase()
            : String(snap.store_sku || "").trim();

        if (Number.isFinite(price) && key && storeSkuForObserve) {
            if (this.observeAllowed(key, price)) {
            const payload = {
                store: site,
                store_sku: storeSkuForObserve,
                price_cents: price,
                title: snap.title || "",
                observed_at: new Date().toISOString(),
            };

            if (site === "bestbuy") payload.url = String(location.href || "");

            safeSend({ type: "OBSERVE_PRICE", payload })
                .then((r) => { if (r?.ok) this.observeRemember(key, price); })
                .catch(() => {});
            }
        }
        }

        await safeSet({ lastSnapshot: snap });

        // Footer dashboard link
        {
        const a = root.querySelector("#ps-footer-link");
        if (a) {
            const key = keyForCurrentPage(site, snap);
            a.href = dashboardUrlForKey(key, snap.title);
        }
        }

        // Results container
        const resultsEl = root.querySelector("#ps-results");
        if (!resultsEl) {
        console.warn("PriceCheck: #ps-results not found. content.html likely missing id='ps-results'.");
        // Debug aid
        try {
            console.log("PriceCheck debug: root has elements =", root.querySelectorAll("*").length);
            console.log("PriceCheck debug: root innerHTML head =", String(root.innerHTML || "").slice(0, 200));
        } catch {}
        return;
        }

        resultsEl.innerHTML = "";

        const statusEl = document.createElement("div");
        statusEl.className = "status";
        statusEl.textContent = "Searching...";
        resultsEl.appendChild(statusEl);

        // Hide warn initially
        {
        const warnEl = root.querySelector("#ps-warn");
        if (warnEl) warnEl.hidden = true;
        }

        // Header product id line
        {
        const prodLabelEl = root.querySelector(".asin-row strong");
        const prodValEl = root.querySelector("#ps-asin-val");

        if (prodLabelEl && prodValEl) {
            if (site === "amazon") {
            prodLabelEl.textContent = "ASIN";
            prodValEl.textContent = snap.asin || "Not found";
            } else if (site === "target") {
            prodLabelEl.textContent = "TCIN";
            prodValEl.textContent = snap.store_sku || "Not found";
            } else {
            prodLabelEl.textContent = "SKU";
            prodValEl.textContent = snap.store_sku || "Not found";
            }
        }
        }

        const keyNow = this.makeKey();

        const callAPI = async () => {
        if (site === "amazon") {
            if (!snap.asin) return null;
            return await safeSend({ type: "COMPARE_REQUEST", payload: { asin: snap.asin } });
        } else {
            if (!snap.store_sku) return null;
            return await safeSend({
            type: "RESOLVE_COMPARE_REQUEST",
            payload: { store: site, store_sku: snap.store_sku },
            });
        }
        };

        // ---- API call with retry + stale guard ----
        let resp = await callAPI();
        if (seq !== this.populateSeq) return;

        if (!resp || !Array.isArray(resp.results)) {
        await new Promise((r) => setTimeout(r, 250));
        resp = await callAPI();
        if (seq !== this.populateSeq) return;
        }

        let list = Array.isArray(resp?.results) ? resp.results.slice() : null;

        if (!list) {
        const cached = this.lastGood.get(keyNow);
        if (cached && (Date.now() - cached.at) < 60_000) list = cached.results.slice();
        else list = [];
        }

        // Recall alert
        const recallUrl = Array.isArray(list)
        ? (list.find(r => nonEmpty(r?.recall_url))?.recall_url || null)
        : null;

        setRecallAlert(root, recallUrl);

        // Dropship warning
        {
        const warnEl = root.querySelector("#ps-warn");
        if (warnEl) {
            const show = Array.isArray(list) && list.some((r) => r?.dropship_warning === true);
            warnEl.hidden = !show;
        }
        }

        if (list.length) {
        this.lastGood.set(keyNow, { at: Date.now(), results: list.slice() });
        }

        // Brand + category line
        {
        const bcEl = root.querySelector("#ps-variant-val");
        if (bcEl) {
            let src = list.find((r) => (r.store || "").toLowerCase() === "amazon");
            if (!src) src = list.find((r) => r.brand || r.category);
            const brand = src?.brand || "";
            const category = src?.category || "";
            const bc = [brand, category].filter(Boolean).join(" ");
            bcEl.textContent = bc || "N/A";
        }
        }

        statusEl.textContent = "";

        // Empty state
        if (!list.length) {
        if (site === "amazon" && !snap.asin) statusEl.textContent = "ASIN not found.";
        else if (site !== "amazon" && !snap.store_sku) statusEl.textContent = "No product ID found.";
        else statusEl.textContent = "No prices found.";
        this.lastKey = this.makeKey();
        return;
        }

        // Only keep entries with real prices
        const priced = list.filter((p) => Number.isFinite(p?.price_cents));
        if (!priced.length) {
        statusEl.textContent = "Matches found, but no stored prices yet.";
        const w = root.querySelector("#ps-warn");
        if (w) w.hidden = true;
        this.lastKey = this.makeKey();
        return;
        }

        // Sort cheapest -> most expensive
        priced.sort((a, b) => a.price_cents - b.price_cents);

        const ICON = (k) => ICONS[k] || ICONS.default;

        const currentStore = storeKey(site);
        const cheapestPrice = priced[0].price_cents;
        const mostExpensivePrice = priced[priced.length - 1].price_cents;

        priced.forEach((p) => {
        const storeLower = storeKey(p.store);
        const isCurrentSite = storeLower === currentStore;

        let tagsHTML = "";

        if (p.price_cents === cheapestPrice && mostExpensivePrice > cheapestPrice) {
            const diff = (mostExpensivePrice - cheapestPrice) / 100;
            tagsHTML += `<span class="savings-tag">Save $${diff.toFixed(2)}</span>`;
        }

        const card = document.createElement("a");
        card.className = "result-card";
        if (isCurrentSite) card.classList.add("current-site");

        card.href = p.url || "#";
        card.target = "_blank";

        const offerPillHTML = offerTagPill(p.offer_tag, isCurrentSite);

        card.innerHTML = `
            <div class="store-info">
            <img src="${ICON(storeLower)}" class="store-logo" />
            <div class="store-and-product">
                <div class="store-line">
                <span class="store-name">${escHtml(storeLabel(p.store))}</span>
                ${offerPillHTML}
                </div>
            </div>
            </div>
            <div class="price-info">
            <span class="price">$${(p.price_cents / 100).toFixed(2)}</span>
            ${tagsHTML}
            </div>
        `;

        resultsEl.appendChild(card);
        });

        this.lastKey = this.makeKey();
    } finally {
        if (seq === this.populateSeq) this.isPopulating = false;
    }
    }