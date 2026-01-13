import { hasChrome, siteOf, safeSend, safeSet, storeKey } from "./env.js";
import { DRIVERS } from "./drivers.js";
import { ensurePanel, open as uiOpen, close as uiClose } from "./ui.js";
import { populate } from "./populate.js"; // your refactored populate

export function initPriceCheck() {
  "use strict";
  try { document.documentElement.dataset.pricecheckInit = "1"; } catch {}

  const state = {
    width: 380,
    open: false,
    root: null,
    shadow: null,
    container: null,

    populateTimer: null,
    watchTimer: null,
    lastKey: null,
    populateSeq: 0,
    isPopulating: false,
    lastGood: new Map(),
    observeMem: new Map(),
    observeWindow: [],

    async ensure() {
      const htmlUrl = chrome.runtime.getURL("content.html");
      const cssUrl = chrome.runtime.getURL("content.css");
      const logoUrl = chrome.runtime.getURL("icons/logo.png");
      await ensurePanel(state, { htmlUrl, cssUrl, logoUrl });
    },

    async openSidebar() {
      await state.ensure();
      uiOpen(state);
      await populate(state, { DRIVERS, siteOf, safeSend, safeSet, storeKey });
      state.startWatcher();
    },

    close() {
      uiClose(state);
      state.stopWatcher();
    },

    toggle() {
      state.open ? state.close() : state.openSidebar();
    },

    makeKey() {
      const site = siteOf();
      const D = DRIVERS[site] || DRIVERS.amazon;
      const asin = D.getASIN ? D.getASIN() : null;
      const sku = D.getStoreSKU ? D.getStoreSKU() : null;
      return [site, asin, sku, location.href].join("|");
    },

    startWatcher() {
      if (state.watchTimer) return;
      state.lastKey = state.makeKey();
      state.watchTimer = setInterval(() => {
        if (!state.open) return;
        const k = state.makeKey();
        if (k === state.lastKey) return;
        state.lastKey = k;
        if (state.populateTimer) clearTimeout(state.populateTimer);
        state.populateTimer = setTimeout(() => {
          if (!state.open || state.isPopulating) return;
          populate(state, { DRIVERS, siteOf, safeSend, safeSet, storeKey });
        }, 350);
      }, 600);
    },

    stopWatcher() {
      if (state.watchTimer) clearInterval(state.watchTimer);
      state.watchTimer = null;
      if (state.populateTimer) clearTimeout(state.populateTimer);
      state.populateTimer = null;
    },
  };

  // message hook
  try {
    if (hasChrome() && chrome.runtime?.onMessage?.addListener) {
      chrome.runtime.onMessage.addListener((m) => {
        if (m?.type === "TOGGLE_SIDEBAR") state.toggle();
      });
    }
  } catch {}

  globalThis.__PC_SINGLETON__ = state;
}
