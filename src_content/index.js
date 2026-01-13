import { initPriceCheck } from "./sidebar.js";

(() => {
  "use strict";

  if (globalThis.__PC_INIT_DONE__) return;
  globalThis.__PC_INIT_DONE__ = true;

  initPriceCheck();
})();
