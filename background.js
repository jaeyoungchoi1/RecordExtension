const DEFAULT_SETTINGS = {
  enabled: false,
  viewportWidth: 1080,
  viewportHeight: 720,
  scrollStep: 500,
  userId: "",
  taskId: "",
  isRecording: false
};

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DB_NAME = "gazeaware-recorder";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "logRoot";

const attachedTabs = new Set();
const tabNumbers = new Map();
const tabOrders = new Map();
const pageLogsByTab = new Map();
const pageLogRuns = new Map();
const pendingInteractionsByTab = new Map();
const pendingNavigationClicksByTab = new Map();
const pendingNewTabs = new Map();
const NAVIGATION_CLICK_TTL_MS = 10000;

let nextTabNumber = 1;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "GAZEAWARE_APPLY_VIEWPORT") {
    applyViewportToActiveTab()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GAZEAWARE_START_RECORDING") {
    startRecordingForActiveTab()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GAZEAWARE_STOP_RECORDING") {
    stopRecordingForAllTabs()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GAZEAWARE_INTERACTION") {
    appendInteraction(sender.tab && sender.tab.id, message.interaction)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GAZEAWARE_NAVIGATION_CLICK") {
    rememberNavigationClick(sender.tab && sender.tab.id, message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.isRecording) {
    if (changes.isRecording.newValue) {
      startRecordingForActiveTab().catch(() => {});
    } else {
      stopRecordingForAllTabs().catch(() => {});
    }
  }

  if (changes.enabled || changes.viewportWidth || changes.viewportHeight) {
    applyViewportToActiveTab().catch(() => {});
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  handleCreatedTab(tab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (pendingNewTabs.has(tabId) && isWebUrl(tab.url)) {
    redirectPendingNewTab(tabId, tab.url).catch(() => {});
    return;
  }

  if (changeInfo.url) {
    confirmNavigationClick(tabId, changeInfo.url).catch(() => {});
  }

  if (changeInfo.status !== "complete" || !isWebUrl(tab.url)) {
    return;
  }

  getSettings().then((settings) => {
    const tasks = [];
    if (settings.enabled) {
      tasks.push(applyViewportToTab(tabId, settings));
    }
    if (settings.isRecording) {
      tasks.push(schedulePageLog(tabId));
    }
    Promise.all(tasks).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabNumbers.delete(tabId);
  tabOrders.delete(tabId);
  pageLogsByTab.delete(tabId);
  pageLogRuns.delete(tabId);
  pendingInteractionsByTab.delete(tabId);
  pendingNavigationClicksByTab.delete(tabId);
  pendingNewTabs.delete(tabId);
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

  if (settings.isRecording) {
    await schedulePageLog(tab.id);
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: Boolean(stored.enabled),
    viewportWidth: toPositiveInteger(stored.viewportWidth, DEFAULT_SETTINGS.viewportWidth),
    viewportHeight: toPositiveInteger(stored.viewportHeight, DEFAULT_SETTINGS.viewportHeight),
    scrollStep: toPositiveInteger(stored.scrollStep, DEFAULT_SETTINGS.scrollStep),
    userId: sanitizePathPart(stored.userId),
    taskId: sanitizePathPart(stored.taskId),
    isRecording: Boolean(stored.isRecording)
  };
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function applyViewportToTab(tabId, settings) {
  const target = { tabId };
  await prepareDebuggerDomains(target);
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

async function prepareDebuggerDomains(target) {
  await attachDebugger(target);
  await sendCommand(target, "Page.enable");
  await sendCommand(target, "Runtime.enable");
  await sendCommand(target, "Accessibility.enable").catch(() => {});
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

async function handleCreatedTab(tab) {
  if (!tab.openerTabId) {
    return;
  }

  const settings = await getSettings();
  if (!settings.isRecording) {
    return;
  }

  const url = tab.pendingUrl || tab.url;
  if (isWebUrl(url)) {
    await redirectNewTabToOpener(tab.id, tab.openerTabId, url);
    return;
  }

  pendingNewTabs.set(tab.id, tab.openerTabId);
}

async function startRecordingForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !isWebUrl(tab.url)) {
    return;
  }

  const settings = await getSettings();
  if (settings.enabled) {
    await applyViewportToTab(tab.id, settings);
  }
  await schedulePageLog(tab.id);
}

async function stopRecordingForAllTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => stopRecordingForTab(tab.id)));
}

async function stopRecordingForTab(tabId) {
  pageLogRuns.set(tabId, (pageLogRuns.get(tabId) || 0) + 1);
  pageLogsByTab.delete(tabId);
  pendingInteractionsByTab.delete(tabId);
  pendingNavigationClicksByTab.delete(tabId);
  pendingNewTabs.delete(tabId);

  const settings = await getSettings();
  if (!settings.enabled) {
    await clearViewportForTab(tabId);
  }
}

async function redirectPendingNewTab(tabId, url) {
  const openerTabId = pendingNewTabs.get(tabId);
  if (!openerTabId) {
    return;
  }

  pendingNewTabs.delete(tabId);
  await redirectNewTabToOpener(tabId, openerTabId, url);
}

async function redirectNewTabToOpener(newTabId, openerTabId, url) {
  if (!isWebUrl(url)) {
    return;
  }

  await chrome.tabs.update(openerTabId, { url, active: true });
  await chrome.tabs.remove(newTabId).catch(() => {});
}

async function schedulePageLog(tabId) {
  const runId = (pageLogRuns.get(tabId) || 0) + 1;
  pageLogRuns.set(tabId, runId);

  await sleep(1600);

  if (pageLogRuns.get(tabId) !== runId) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab || !isWebUrl(tab.url)) {
    return;
  }

  await createPageLog(tabId, tab);
}

async function createPageLog(tabId, tab) {
  const settings = await getSettings();
  if (!settings.isRecording) {
    return;
  }

  const target = { tabId };
  if (settings.enabled) {
    await applyViewportToTab(tabId, settings);
  } else {
    await prepareDebuggerDomains(target);
  }
  await waitForPageStable(target);

  const tabNumber = getTabNumber(tabId);
  const order = getNextOrder(tabId);
  const ts = fileTimestamp();
  const baseName = `web_tab${tabNumber}_${ts}`;
  const jsonFile = `${baseName}.json`;
  const domFile = `${baseName}.html`;
  const cssFile = `${baseName}.css`;
  const a11yFile = `${baseName}_a11y_tree.json`;
  const screenshotFile = `${baseName}.png`;

  const [title, domSnapshot, cssSnapshot, a11yTree, screenshotBase64] = await Promise.all([
    getPageTitle(target, tab),
    captureDomSnapshot(target),
    captureCssSnapshot(target),
    captureA11yTree(target),
    captureScreenshot(target).catch((error) => {
      console.warn("GazeAware: unable to capture page screenshot", error);
      return null;
    })
  ]);

  await writeWebLogFile(domFile, domSnapshot, "text/html;charset=utf-8");
  await writeWebLogFile(cssFile, cssSnapshot, "text/css;charset=utf-8");
  await writeWebLogFile(a11yFile, JSON.stringify(a11yTree, null, 2), "application/json;charset=utf-8");
  if (screenshotBase64) {
    await writeWebLogFile(screenshotFile, screenshotBase64, "image/png", { base64: true });
  }

  const createdAt = new Date().toISOString();
  const pageLog = {
    url: tab.url,
    title,
    order,
    created_at: createdAt,
    dom_file: domFile,
    web_css: cssFile,
    a11y_file: a11yFile,
    interaction: [
      {
        type: "page",
        timestamp: createdAt,
        scroll: 0,
        screenshot_file: screenshotBase64 ? screenshotFile : null
      }
    ]
  };

  pageLogsByTab.set(tabId, {
    baseName,
    jsonFile,
    log: pageLog,
    interactionCount: 0
  });

  await writePageLog(tabId);
  await flushPendingInteractions(tabId);
}

async function appendInteraction(tabId, interaction) {
  if (!tabId || !interaction || !interaction.type) {
    return;
  }

  const settings = await getSettings();
  if (!settings.isRecording) {
    return;
  }

  const entry = {
    type: normalizeInteractionType(interaction.type),
    timestamp: interaction.timestamp || new Date().toISOString(),
    scroll: Number.isFinite(Number(interaction.scroll)) ? Number(interaction.scroll) : 0,
    screenshot_file: null
  };

  const pageState = pageLogsByTab.get(tabId);
  if (!pageState) {
    const pending = pendingInteractionsByTab.get(tabId) || [];
    pending.push(entry);
    pendingInteractionsByTab.set(tabId, pending);
    return;
  }

  await appendInteractionToPageLog(tabId, entry);
}

async function rememberNavigationClick(tabId, message) {
  if (!tabId || !isWebUrl(message.href) || !isWebUrl(message.sourceUrl)) {
    return;
  }

  pendingNavigationClicksByTab.set(tabId, {
    href: message.href,
    sourceUrl: message.sourceUrl,
    timestamp: new Date().toISOString(),
    createdAtMs: Date.now()
  });
}

async function confirmNavigationClick(tabId, newUrl) {
  const pendingClick = pendingNavigationClicksByTab.get(tabId);
  if (!pendingClick || !isWebUrl(newUrl)) {
    return;
  }

  pendingNavigationClicksByTab.delete(tabId);
  if (Date.now() - pendingClick.createdAtMs > NAVIGATION_CLICK_TTL_MS) {
    return;
  }

  if (sameUrlWithoutHash(pendingClick.sourceUrl, newUrl)) {
    return;
  }

  await appendInteraction(tabId, {
    type: "click",
    timestamp: pendingClick.timestamp,
    scroll: 0
  });
}

async function flushPendingInteractions(tabId) {
  const pending = pendingInteractionsByTab.get(tabId) || [];
  pendingInteractionsByTab.delete(tabId);

  for (const entry of pending) {
    await appendInteractionToPageLog(tabId, entry);
  }
}

async function appendInteractionToPageLog(tabId, entry) {
  const pageState = pageLogsByTab.get(tabId);
  if (!pageState) {
    return;
  }

  if (entry.type === "scrollTop" || entry.type === "scrollBottom") {
    pageState.interactionCount += 1;
    const screenshotFile = `${pageState.baseName}_scroll_${String(pageState.interactionCount).padStart(3, "0")}.png`;
    const screenshotBase64 = await captureScreenshot({ tabId }).catch((error) => {
      console.warn("GazeAware: unable to capture interaction screenshot", error);
      return null;
    });
    if (screenshotBase64) {
      await writeWebLogFile(screenshotFile, screenshotBase64, "image/png", { base64: true });
      entry.screenshot_file = screenshotFile;
    }
  }

  pageState.log.interaction.push(entry);
  await writePageLog(tabId);
}

function normalizeInteractionType(type) {
  if (type === "scrollTop" || type === "scrollBottom" || type === "click") {
    return type;
  }
  return "click";
}

function sameUrlWithoutHash(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search;
  } catch (error) {
    return left === right;
  }
}

async function writePageLog(tabId) {
  const pageState = pageLogsByTab.get(tabId);
  if (!pageState) {
    return;
  }

  await writeWebLogFile(
    pageState.jsonFile,
    JSON.stringify(pageState.log, null, 2),
    "application/json;charset=utf-8"
  );
}

async function waitForPageStable(target) {
  await sleep(900);
  await sendCommand(target, "Runtime.evaluate", {
    expression: `
      new Promise((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        };
        if (document.readyState === "complete") {
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(finish).catch(finish);
          } else {
            finish();
          }
        } else {
          window.addEventListener("load", finish, { once: true });
        }
        setTimeout(finish, 1500);
      })
    `,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => {});
  await sleep(300);
}

async function getPageTitle(target, tab) {
  const result = await sendCommand(target, "Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true
  }).catch(() => null);
  return result && result.result ? result.result.value || tab.title || "" : tab.title || "";
}

async function captureDomSnapshot(target) {
  const result = await sendCommand(target, "Runtime.evaluate", {
    expression: `document.documentElement ? "<!doctype html>\\n" + document.documentElement.outerHTML : ""`,
    returnByValue: true
  });
  return result.result.value || "";
}

async function captureCssSnapshot(target) {
  const result = await sendCommand(target, "Runtime.evaluate", {
    expression: `
      (() => {
        const chunks = [];
        for (const sheet of Array.from(document.styleSheets)) {
          const label = sheet.href || "inline stylesheet";
          try {
            const rules = Array.from(sheet.cssRules || []).map((rule) => rule.cssText).join("\\n");
            chunks.push("/* " + label + " */\\n" + rules);
          } catch (error) {
            chunks.push("/* " + label + " unavailable: " + error.message + " */");
          }
        }
        return chunks.join("\\n\\n");
      })()
    `,
    returnByValue: true
  }).catch(() => null);
  return result && result.result ? result.result.value || "" : "";
}

async function captureA11yTree(target) {
  const result = await sendCommand(target, "Accessibility.getFullAXTree").catch((error) => ({
    error: error.message,
    nodes: []
  }));
  return result;
}

async function captureScreenshot(target) {
  await waitForNextFrame(target);
  const result = await sendCommand(target, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  return result.data;
}

async function waitForNextFrame(target) {
  await sendCommand(target, "Runtime.evaluate", {
    expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
    returnByValue: true
  }).catch(() => {});
}

function getTabNumber(tabId) {
  if (!tabNumbers.has(tabId)) {
    tabNumbers.set(tabId, nextTabNumber);
    nextTabNumber += 1;
  }
  return tabNumbers.get(tabId);
}

function getNextOrder(tabId) {
  const order = (tabOrders.get(tabId) || 0) + 1;
  tabOrders.set(tabId, order);
  return order;
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeWebLogFile(filename, content, mimeType, options = {}) {
  const rootHandle = await getStoredRootHandle().catch(() => null);
  if (rootHandle && await hasReadWritePermission(rootHandle)) {
    try {
      await writeWithFileSystemAccess(rootHandle, filename, content, options);
      await chrome.storage.local.set({ webLogWriteStatus: "ok" });
      return;
    } catch (error) {
      console.warn("GazeAware: unable to write through File System Access API", error);
    }
  }

  await chrome.storage.local.set({
    webLogWriteStatus: "missing_log_folder_permission",
    webLogWriteStatusUpdatedAt: new Date().toISOString()
  });
  console.warn(`GazeAware: skipped ${filename}; choose Log Folder and press Save Setup to grant write permission.`);
}

async function writeWithFileSystemAccess(rootHandle, filename, content, options = {}) {
  const settings = await getSettings();
  if (!settings.userId || !settings.taskId) {
    throw new Error("User ID and Task ID are required before writing web logs.");
  }

  const taskLogsDir = await rootHandle.getDirectoryHandle("task_logs", { create: true });
  const userDir = await taskLogsDir.getDirectoryHandle(`User ${settings.userId}`, { create: true });
  const taskDir = await userDir.getDirectoryHandle(settings.taskId, { create: true });
  const webLogsDir = await taskDir.getDirectoryHandle("web_logs", { create: true });
  const fileHandle = await webLogsDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(options.base64 ? base64ToUint8Array(content) : content);
  await writable.close();
}

async function getStoredRootHandle() {
  const db = await openDatabase();
  const handle = await idbRequest(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ROOT_HANDLE_KEY));
  db.close();
  return handle || null;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function hasReadWritePermission(handle) {
  if (!handle.queryPermission) {
    return true;
  }

  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePathPart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");
}

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}
