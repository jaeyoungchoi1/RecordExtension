const DEFAULT_SETTINGS = {
  enabled: false,
  viewportWidth: 1080,
  viewportHeight: 720,
  scrollStep: 120
};

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GAZEAWARE_APPLY_VIEWPORT") {
    return false;
  }

  applyViewportToActiveTab()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.enabled && !changes.viewportWidth && !changes.viewportHeight) {
    return;
  }

  applyViewportToActiveTab().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isWebUrl(tab.url)) {
    return;
  }

  getSettings().then((settings) => {
    if (settings.enabled) {
      applyViewportToTab(tabId, settings).catch(() => {});
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
  }
});

async function applyViewportToActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !isWebUrl(tab.url)) {
    return;
  }

  const settings = await getSettings();
  if (settings.enabled) {
    await applyViewportToTab(tab.id, settings);
  } else {
    await clearViewportForTab(tab.id);
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: Boolean(stored.enabled),
    viewportWidth: toPositiveInteger(stored.viewportWidth, DEFAULT_SETTINGS.viewportWidth),
    viewportHeight: toPositiveInteger(stored.viewportHeight, DEFAULT_SETTINGS.viewportHeight),
    scrollStep: toPositiveInteger(stored.scrollStep, DEFAULT_SETTINGS.scrollStep)
  };
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function applyViewportToTab(tabId, settings) {
  const target = { tabId };
  await attachDebugger(target);
  await sendCommand(target, "Emulation.setDeviceMetricsOverride", {
    width: settings.viewportWidth,
    height: settings.viewportHeight,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: settings.viewportWidth,
    screenHeight: settings.viewportHeight,
    positionX: 0,
    positionY: 0,
    scale: 1
  });
  await sendCommand(target, "Emulation.setVisibleSize", {
    width: settings.viewportWidth,
    height: settings.viewportHeight
  });
  await setScrollbarsHidden(target, true);
}

async function clearViewportForTab(tabId) {
  const target = { tabId };
  if (!attachedTabs.has(tabId)) {
    return;
  }

  await setScrollbarsHidden(target, false);
  await sendCommand(target, "Emulation.clearDeviceMetricsOverride");
  await detachDebugger(target);
}

async function attachDebugger(target) {
  if (attachedTabs.has(target.tabId)) {
    return;
  }

  await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
  attachedTabs.add(target.tabId);
}

async function detachDebugger(target) {
  try {
    await chrome.debugger.detach(target);
  } finally {
    attachedTabs.delete(target.tabId);
  }
}

async function sendCommand(target, method, params = {}) {
  return await chrome.debugger.sendCommand(target, method, params);
}

async function setScrollbarsHidden(target, hidden) {
  try {
    await sendCommand(target, "Emulation.setScrollbarsHidden", { hidden });
  } catch (error) {
    console.warn("GazeAware: unable to change scrollbar visibility", error);
  }
}

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}
