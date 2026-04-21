const MANUAL_SEARCH_URL = "https://www.pricechecktool.com/";

const frame = document.getElementById("frame");
const loading = document.getElementById("loading");
const blocked = document.getElementById("blocked");
const unsupported = document.getElementById("unsupported");

const openLink = document.getElementById("openLink");
const blockedOpenHere = document.getElementById("blockedOpenHere");
const unsupportedOpenHere = document.getElementById("unsupportedOpenHere");
const unsupportedOpenTab = document.getElementById("unsupportedOpenTab");
const loadingTitle = document.getElementById("pcLoadingTitle");

let currentToken = 0;
let loadingStepTimer = null;
let loadingStepIndex = 0;

const LOADING_STEPS = [
  "Reading page",
  "Matching product",
  "Opening comparison"
];

function clearLoadingSequence() {
  if (loadingStepTimer) {
    clearInterval(loadingStepTimer);
    loadingStepTimer = null;
  }
  loadingStepIndex = 0;
}

function renderLoadingStep() {
  if (loadingTitle) {
    loadingTitle.textContent = LOADING_STEPS[loadingStepIndex] || LOADING_STEPS[0];
  }
}

function hidePanelsOnly() {
  clearLoadingSequence();
  loading.style.display = "none";
  blocked.style.display = "none";
  unsupported.style.display = "none";
}

function showLoading() {
  currentToken += 1;
  hidePanelsOnly();
  frame.style.display = "none";
  frame.removeAttribute("src");
  loading.style.display = "flex";

  loadingStepIndex = 0;
  renderLoadingStep();

  loadingStepTimer = setInterval(() => {
    if (loading.style.display !== "flex") {
      clearLoadingSequence();
      return;
    }

    if (loadingStepIndex >= LOADING_STEPS.length - 1) {
      clearLoadingSequence();
      return;
    }

    loadingStepIndex += 1;
    renderLoadingStep();
  }, 650);
}

function showBlocked(url) {
  currentToken += 1;
  hidePanelsOnly();
  frame.style.display = "none";
  frame.removeAttribute("src");
  blocked.style.display = "flex";

  if (openLink) {
    openLink.dataset.url = String(url || MANUAL_SEARCH_URL).trim() || MANUAL_SEARCH_URL;
  }
}

function showUnsupported(url) {
  currentToken += 1;
  hidePanelsOnly();
  frame.style.display = "none";
  frame.removeAttribute("src");
  unsupported.style.display = "flex";

  const next = String(url || MANUAL_SEARCH_URL).trim() || MANUAL_SEARCH_URL;

  if (unsupportedOpenTab) {
    unsupportedOpenTab.dataset.url = next;
  }
}

function loadUrl(url) {
  const next = String(url || "").trim();
  if (!next) {
    showLoading();
    return;
  }

  const token = ++currentToken;

  hidePanelsOnly();
  loading.style.display = "flex";
  frame.style.display = "block";

  if (openLink) {
    openLink.dataset.url = next;
  }
  if (unsupportedOpenTab) {
    unsupportedOpenTab.dataset.url = next;
  }

  const onLoad = () => {
    if (token !== currentToken) return;
    frame.removeEventListener("load", onLoad);
    hidePanelsOnly();
    frame.style.display = "block";
  };

  frame.addEventListener("load", onLoad, { once: true });
  frame.src = next;
}

async function sendMessage(msg, timeoutMs = 2500) {
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(msg),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs)
      ),
    ]);
  } catch (e) {
    console.log("[pc:sidepanel] sendMessage failed", String(e));
    return { ok: false, error: String(e) };
  }
}

function renderPanelState(state = null) {
  if (!state || typeof state !== "object") {
    showUnsupported(MANUAL_SEARCH_URL);
    return;
  }

  const mode = String(state.mode || "").trim();
  const url = String(state.url || "").trim();

  console.log("[pc:sidepanel] rendering panel state:", { mode, url });

  if (mode === "loading") {
    showLoading();
    return;
  }

  if (mode === "unsupported") {
    showUnsupported(url || MANUAL_SEARCH_URL);
    return;
  }

  if (mode === "iframe") {
    if (!url) {
      showUnsupported(MANUAL_SEARCH_URL);
      return;
    }
    loadUrl(url);
    return;
  }

  // Unknown mode, show unsupported
  showUnsupported(MANUAL_SEARCH_URL);
}

async function readActivePanelState() {
  const resp = await sendMessage({ type: "PC_READ_ACTIVE_PANEL_STATE" });
  if (resp?.ok) return resp.state || null;
  return null;
}

async function syncActivePanelState() {
  const resp = await sendMessage({ type: "PC_SYNC_ACTIVE_PANEL_STATE" });
  if (resp?.ok) return resp.state || null;
  return null;
}

async function openManualSearchInSidebar(url = MANUAL_SEARCH_URL) {
  const next = String(url || MANUAL_SEARCH_URL).trim() || MANUAL_SEARCH_URL;

  const resp = await sendMessage({
    type: "PC_OPEN_MANUAL_SEARCH",
    url: next,
  });

  if (resp?.ok && resp.state) {
    renderPanelState(resp.state);
    return;
  }

  loadUrl(next);
}

async function openInNewTabAndClose(url = MANUAL_SEARCH_URL) {
  const next = String(url || MANUAL_SEARCH_URL).trim() || MANUAL_SEARCH_URL;

  try {
    await chrome.tabs.create({ url: next });
  } catch (e) {
    console.log("[pc:sidepanel] open tab failed", String(e));
    return;
  }

  try {
    const win = await chrome.windows.getCurrent();
    if (win?.id != null && chrome.sidePanel?.close) {
      await chrome.sidePanel.close({ windowId: win.id });
    }
  } catch (e) {
    console.log("[pc:sidepanel] close sidepanel failed", String(e));
  }
}

// Event listeners
if (blockedOpenHere) {
  blockedOpenHere.addEventListener("click", (e) => {
    e.preventDefault();
    openManualSearchInSidebar(MANUAL_SEARCH_URL);
  });
}

if (unsupportedOpenHere) {
  unsupportedOpenHere.addEventListener("click", (e) => {
    e.preventDefault();
    openManualSearchInSidebar(MANUAL_SEARCH_URL);
  });
}

if (openLink) {
  openLink.addEventListener("click", async (e) => {
    e.preventDefault();
    await openInNewTabAndClose(openLink.dataset.url || MANUAL_SEARCH_URL);
  });
}

if (unsupportedOpenTab) {
  unsupportedOpenTab.addEventListener("click", async (e) => {
    e.preventDefault();
    await openInNewTabAndClose(unsupportedOpenTab.dataset.url || MANUAL_SEARCH_URL);
  });
}

async function refreshFromStorageOnly() {
  console.log("[pc:sidepanel] refreshing from storage...");
  const state = await readActivePanelState();
  if (state) {
    console.log("[pc:sidepanel] storage state found:", state);
    renderPanelState(state);
  } else {
    console.log("[pc:sidepanel] no state in storage");
  }
}

async function refreshFromFreshSync() {
  console.log("[pc:sidepanel] starting fresh sync...");
  
  // First, read current state
  const prevState = await readActivePanelState();
  const prevMode = String(prevState?.mode || "").trim();
  console.log("[pc:sidepanel] previous state:", { prevMode, state: prevState });

  // Show loading initially while we sync
  showLoading();

  // Now actually sync with background
  console.log("[pc:sidepanel] syncing from background...");
  const state = await syncActivePanelState();
  
  if (state) {
    console.log("[pc:sidepanel] sync returned new state:", state);
    renderPanelState(state);
  } else {
    console.log("[pc:sidepanel] sync returned nothing, checking storage...");
    // If sync fails, read from storage directly
    const storageState = await readActivePanelState();
    if (storageState) {
      console.log("[pc:sidepanel] found state in storage:", storageState);
      renderPanelState(storageState);
    } else {
      console.log("[pc:sidepanel] no state found, showing unsupported");
      showUnsupported(MANUAL_SEARCH_URL);
    }
  }
}

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const changedKeys = Object.keys(changes || {});
  const panelStateChanges = changedKeys.filter((k) => k.startsWith("pc_panel_state_"));
  
  if (!panelStateChanges.length) return;

  console.log("[pc:sidepanel] storage changed for keys:", panelStateChanges);
  
  // Small delay to ensure storage write is complete
  setTimeout(() => {
    refreshFromStorageOnly().catch((e) => {
      console.log("[pc:sidepanel] storage render failed", String(e));
      showUnsupported(MANUAL_SEARCH_URL);
    });
  }, 100);
});

// Initial render
console.log("[pc:sidepanel] initializing...");
refreshFromFreshSync().catch((e) => {
  console.log("[pc:sidepanel] initial render failed", String(e));
  showUnsupported(MANUAL_SEARCH_URL);
});