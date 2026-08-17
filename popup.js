const TASKS = Array.isArray(globalThis.GAZEAWARE_TASKS) ? globalThis.GAZEAWARE_TASKS : [];
const TASK_CATALOG_VERSION = globalThis.GAZEAWARE_TASK_CATALOG_VERSION || "unspecified";

const DEFAULT_SETTINGS = {
  enabled: true,
  viewportMode: "adaptive",
  viewportWidth: 1080,
  viewportHeight: 720,
  scrollStep: 200,
  userId: "",
  taskId: "",
  environmentType: "real",
  taskVersion: TASK_CATALOG_VERSION,
  taskPrompt: "",
  syntheticAppVersion: "",
  datasetVersion: "",
  datasetSeed: "",
  dbStartSnapshotId: "",
  outcomeStatus: "",
  finalChoice: "",
  dbEndSnapshotId: "",
  outcomeNotes: "",
  isRecording: false
};

const DB_NAME = "gazeaware-recorder";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "logRoot";

const fields = Object.fromEntries([
  "enabled", "userId", "taskId", "environmentType", "taskVersion", "taskPrompt",
  "syntheticAppVersion", "datasetVersion", "datasetSeed", "dbStartSnapshotId",
  "viewportMode", "viewportWidth", "viewportHeight", "scrollStep", "chooseFolder", "folderStatus",
  "saveSetup", "stopRecording", "outcomeStatus", "finalChoice", "dbEndSnapshotId", "outcomeNotes", "message"
].map((id) => [id, document.getElementById(id)]));

const views = {
  taskSummaryTitle: document.getElementById("taskSummaryTitle"),
  taskSummaryPrompt: document.getElementById("taskSummaryPrompt"),
  viewportStatus: document.getElementById("viewportStatus"),
  manualViewportFields: document.getElementById("manualViewportFields"),
  syntheticFields: document.getElementById("syntheticFields"),
  outcomeSection: document.getElementById("outcomeSection")
};

const setupControls = [
  fields.userId, fields.taskId, fields.environmentType, fields.taskVersion, fields.taskPrompt,
  fields.syntheticAppVersion, fields.datasetVersion, fields.datasetSeed, fields.dbStartSnapshotId,
  fields.viewportMode, fields.viewportWidth, fields.viewportHeight, fields.scrollStep,
  fields.enabled, fields.chooseFolder
];

let lastDetectedViewport = null;

document.addEventListener("DOMContentLoaded", initialize);
fields.chooseFolder.addEventListener("click", chooseLogFolder);
fields.saveSetup.addEventListener("click", startRecording);
fields.stopRecording.addEventListener("click", stopRecording);
fields.enabled.addEventListener("change", persistSettingsOnly);
fields.environmentType.addEventListener("change", updateSyntheticVisibility);
fields.taskId.addEventListener("change", () => handleTaskSelection({ replaceMetadata: true, persist: true }));
fields.viewportMode.addEventListener("change", () => updateViewportMode({ detect: true, persist: true }));

async function initialize() {
  populateTaskOptions();
  const existing = await chrome.storage.local.get(null);
  const migrated = { ...existing };
  if (positiveInteger(existing.recorderDefaultsVersion, 0) < 3) {
    if (existing.scrollStep == null || Number(existing.scrollStep) >= 500) migrated.scrollStep = 200;
    migrated.enabled = true;
    migrated.recorderDefaultsVersion = 3;
    await chrome.storage.local.set({
      scrollStep: migrated.scrollStep ?? DEFAULT_SETTINGS.scrollStep,
      enabled: migrated.enabled ?? DEFAULT_SETTINGS.enabled,
      recorderDefaultsVersion: 3
    });
  }
  const stored = { ...DEFAULT_SETTINGS, ...migrated };
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const field = fields[key];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = Boolean(stored[key]);
    else field.value = stored[key] ?? fallback;
  }

  if (!TASKS.some((task) => task.taskId === fields.taskId.value)) fields.taskId.value = "";
  handleTaskSelection({ replaceMetadata: !fields.taskPrompt.value, persist: false });
  updateRecordingButtons(Boolean(stored.isRecording));
  updateSyntheticVisibility();
  updateViewportMode({ detect: false, persist: false });
  await Promise.all([updateFolderStatus(), refreshDetectedViewport({ quiet: true })]);

  if (stored.lastSessionResult && !stored.isRecording) {
    const result = stored.lastSessionResult;
    setMessage(`${result.status}: ${result.event_count} events, ${result.state_count} states`);
  }
}

function populateTaskOptions() {
  for (const task of TASKS) {
    const option = document.createElement("option");
    option.value = task.taskId;
    option.textContent = `Task ${task.taskId} — ${task.site} — ${task.title}`;
    fields.taskId.append(option);
  }
}

function selectedTask() {
  return TASKS.find((task) => task.taskId === fields.taskId.value) || null;
}

function handleTaskSelection(options = {}) {
  const task = selectedTask();
  if (!task) {
    views.taskSummaryTitle.textContent = "Choose one of the launcher tasks.";
    views.taskSummaryPrompt.textContent = "";
    return;
  }

  views.taskSummaryTitle.textContent = `Task ${task.taskId} · ${task.site} · ${task.title}`;
  views.taskSummaryPrompt.textContent = task.prompt;
  if (options.replaceMetadata) {
    fields.taskPrompt.value = task.prompt;
    fields.taskVersion.value = TASK_CATALOG_VERSION;
    fields.environmentType.value = "real";
    updateSyntheticVisibility();
  }
  if (options.persist) persistSetupDraft().catch((error) => setMessage(error.message));
}

async function chooseLogFolder() {
  clearMessage();
  try {
    await chrome.runtime.openOptionsPage();
    setMessage("Opened folder settings");
  } catch (error) {
    setMessage(error.message);
  }
}

async function startRecording() {
  clearMessage();
  fields.saveSetup.disabled = true;
  try {
    if (fields.viewportMode.value === "adaptive") await refreshDetectedViewport({ required: true });
    const setup = collectSetup();
    const backend = await getStorageBackend();
    if (backend.type === "filesystem" && !(await ensureReadWritePermission(backend.rootHandle))) {
      throw new Error("Log Folder write permission is required.");
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) throw new Error("Open an http(s) task page before starting.");
    fields.outcomeStatus.value = "";
    fields.finalChoice.value = "";
    fields.dbEndSnapshotId.value = "";
    fields.outcomeNotes.value = "";
    await chrome.storage.local.set({
      ...setup,
      outcomeStatus: "",
      finalChoice: "",
      dbEndSnapshotId: "",
      outcomeNotes: ""
    });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const response = await chrome.runtime.sendMessage({
      type: "GAZEAWARE_START_SESSION",
      setup,
      tabId: tab.id,
      streamId
    });
    if (!response?.ok) throw new Error(response?.error || "Recorder did not start.");
    updateRecordingButtons(true);
    setMessage(`Recording Task ${setup.taskId} · ${response.result.session_id}`);
  } catch (error) {
    updateRecordingButtons(false);
    setMessage(error.message);
  }
}

async function stopRecording() {
  clearMessage();
  fields.stopRecording.disabled = true;
  try {
    const outcome = {
      status: fields.outcomeStatus.value,
      finalChoice: fields.finalChoice.value,
      dbEndSnapshotId: fields.dbEndSnapshotId.value,
      notes: fields.outcomeNotes.value
    };
    if (!outcome.status) throw new Error("Select whether the task was completed before finishing.");
    await chrome.storage.local.set({
      outcomeStatus: outcome.status,
      finalChoice: outcome.finalChoice,
      dbEndSnapshotId: outcome.dbEndSnapshotId,
      outcomeNotes: outcome.notes
    });
    const response = await chrome.runtime.sendMessage({ type: "GAZEAWARE_STOP_SESSION", outcome });
    if (!response?.ok) throw new Error(response?.error || "Recorder did not stop cleanly.");
    const result = response.result;
    updateRecordingButtons(false);
    setMessage(`${result.status}: ${result.event_count} events, ${result.state_count} states`);
  } catch (error) {
    updateRecordingButtons(true);
    setMessage(error.message);
  }
}

async function persistSettingsOnly() {
  try {
    if (fields.viewportMode.value === "adaptive") await refreshDetectedViewport({ quiet: true });
    await persistSetupDraft();
    const response = await chrome.runtime.sendMessage({ type: "GAZEAWARE_APPLY_VIEWPORT" });
    if (response && !response.ok) throw new Error(response.error);
  } catch (error) {
    setMessage(error.message);
  }
}

async function persistSetupDraft() {
  await chrome.storage.local.set(collectSetup({ allowEmpty: true }));
}

function collectSetup(options = {}) {
  const userId = sanitizePathPart(String(fields.userId.value || "").replace(/^user\s*/i, ""));
  const task = selectedTask();
  if (!options.allowEmpty && !userId) throw new Error("Participant ID is required.");
  if (!options.allowEmpty && !task) throw new Error("Select a task.");

  return {
    enabled: fields.enabled.checked,
    userId,
    taskId: task?.taskId || "",
    taskNumber: task?.taskNumber || null,
    taskSite: task?.site || "",
    taskTitle: task?.title || "",
    taskUrl: task?.url || "",
    taskCatalogVersion: TASK_CATALOG_VERSION,
    environmentType: fields.environmentType.value,
    taskVersion: fields.taskVersion.value.trim() || TASK_CATALOG_VERSION,
    taskPrompt: fields.taskPrompt.value.trim() || task?.prompt || "",
    syntheticAppVersion: fields.syntheticAppVersion.value.trim(),
    datasetVersion: fields.datasetVersion.value.trim(),
    datasetSeed: fields.datasetSeed.value.trim(),
    dbStartSnapshotId: fields.dbStartSnapshotId.value.trim(),
    viewportMode: fields.viewportMode.value === "manual" ? "manual" : "adaptive",
    viewportWidth: positiveInteger(fields.viewportWidth.value, DEFAULT_SETTINGS.viewportWidth),
    viewportHeight: positiveInteger(fields.viewportHeight.value, DEFAULT_SETTINGS.viewportHeight),
    viewportDetectedAt: lastDetectedViewport?.detectedAt || null,
    viewportDetectedDpr: lastDetectedViewport?.devicePixelRatio || null,
    scrollStep: positiveInteger(fields.scrollStep.value, DEFAULT_SETTINGS.scrollStep)
  };
}

function updateSyntheticVisibility() {
  views.syntheticFields.hidden = fields.environmentType.value !== "synthetic";
}

async function updateViewportMode(options = {}) {
  const adaptive = fields.viewportMode.value !== "manual";
  views.manualViewportFields.hidden = adaptive;
  if (adaptive && options.detect) await refreshDetectedViewport({ quiet: true });
  if (!adaptive) {
    views.viewportStatus.textContent = `${positiveInteger(fields.viewportWidth.value, 1080)} × ${positiveInteger(fields.viewportHeight.value, 720)} manual`;
  }
  if (options.persist) await persistSetupDraft();
}

async function refreshDetectedViewport(options = {}) {
  try {
    views.viewportStatus.textContent = "Detecting current tab…";
    const viewport = await detectCurrentTabViewport();
    lastDetectedViewport = { ...viewport, detectedAt: new Date().toISOString() };
    if (fields.viewportMode.value !== "manual") {
      fields.viewportWidth.value = String(viewport.width);
      fields.viewportHeight.value = String(viewport.height);
      views.viewportStatus.textContent = `${viewport.width} × ${viewport.height} · DPR ${formatDpr(viewport.devicePixelRatio)}`;
    }
    return viewport;
  } catch (error) {
    lastDetectedViewport = null;
    views.viewportStatus.textContent = "Open a web task to detect";
    if (options.required) throw error;
    if (!options.quiet) setMessage(error.message);
    return null;
  }
}

async function detectCurrentTabViewport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) throw new Error("Open an http(s) task page before starting.");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    })
  });
  const result = results?.[0]?.result;
  const width = positiveInteger(result?.width, 0);
  const height = positiveInteger(result?.height, 0);
  if (!width || !height) throw new Error("Could not detect the current web-content size.");
  return {
    width,
    height,
    devicePixelRatio: Number.isFinite(result.devicePixelRatio) ? result.devicePixelRatio : 1
  };
}

function formatDpr(value) {
  return Number(value || 1).toFixed(2).replace(/\.00$/, "");
}

function sanitizePathPart(value) {
  return String(value || "").trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredRootHandle() {
  const db = await openDatabase();
  const handle = await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ROOT_HANDLE_KEY));
  db.close();
  return handle || null;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function ensureReadWritePermission(handle) {
  if (!handle.queryPermission) return true;
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") return true;
  return await handle.requestPermission(options) === "granted";
}

async function updateFolderStatus() {
  const backend = await getStorageBackend({ allowMissing: true });
  if (backend?.type === "downloads") {
    fields.folderStatus.textContent = `Selected: Downloads/${backend.downloadRoot} (automatic write)`;
    return;
  }
  const handle = backend?.rootHandle || null;
  if (!handle) {
    fields.folderStatus.textContent = "No folder selected";
    return;
  }
  const permission = handle.queryPermission ? await handle.queryPermission({ mode: "readwrite" }) : "granted";
  fields.folderStatus.textContent = `Selected: ${handle.name} (${permission})`;
}

async function getStorageBackend(options = {}) {
  const stored = await chrome.storage.local.get({ storageBackend: null, downloadRoot: "GazeAwareRecorder" });
  if (stored.storageBackend === "downloads") {
    return { type: "downloads", downloadRoot: stored.downloadRoot || "GazeAwareRecorder" };
  }
  const rootHandle = await getStoredRootHandle();
  if (rootHandle) return { type: "filesystem", rootHandle };
  if (options.allowMissing) return null;
  throw new Error("Choose a Log Folder first.");
}

function setMessage(text) {
  fields.message.textContent = text;
}

function clearMessage() {
  setMessage("");
}

function updateRecordingButtons(isRecording) {
  fields.saveSetup.hidden = Boolean(isRecording);
  fields.saveSetup.disabled = Boolean(isRecording);
  fields.stopRecording.hidden = !isRecording;
  fields.stopRecording.disabled = !isRecording;
  views.outcomeSection.hidden = !isRecording;
  for (const control of setupControls) control.disabled = Boolean(isRecording);
}
