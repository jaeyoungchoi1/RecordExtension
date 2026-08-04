const DEFAULT_SETTINGS = {
  enabled: false,
  viewportWidth: 1080,
  viewportHeight: 720,
  scrollStep: 120,
  userId: "",
  taskId: "",
  isRecording: false
};

const DB_NAME = "gazeaware-recorder";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "logRoot";

const fields = {
  enabled: document.getElementById("enabled"),
  userId: document.getElementById("userId"),
  taskId: document.getElementById("taskId"),
  viewportWidth: document.getElementById("viewportWidth"),
  viewportHeight: document.getElementById("viewportHeight"),
  scrollStep: document.getElementById("scrollStep"),
  chooseFolder: document.getElementById("chooseFolder"),
  folderStatus: document.getElementById("folderStatus"),
  saveSetup: document.getElementById("saveSetup"),
  stopRecording: document.getElementById("stopRecording"),
  message: document.getElementById("message")
};

document.addEventListener("DOMContentLoaded", initialize);
fields.chooseFolder.addEventListener("click", chooseLogFolder);
fields.saveSetup.addEventListener("click", startRecording);
fields.stopRecording.addEventListener("click", stopRecording);
fields.enabled.addEventListener("change", persistSettingsOnly);

async function initialize() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  fields.enabled.checked = Boolean(stored.enabled);
  fields.userId.value = stored.userId || "";
  fields.taskId.value = stored.taskId || "";
  fields.viewportWidth.value = stored.viewportWidth || DEFAULT_SETTINGS.viewportWidth;
  fields.viewportHeight.value = stored.viewportHeight || DEFAULT_SETTINGS.viewportHeight;
  fields.scrollStep.value = stored.scrollStep || DEFAULT_SETTINGS.scrollStep;
  updateRecordingButtons(Boolean(stored.isRecording));
  await updateFolderStatus();
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
  let didStart = false;

  try {
    const setup = collectSetup();
    await chrome.storage.local.set(setup);
    await writeInitialTaskFiles(setup);
    await chrome.storage.local.set({ isRecording: true });
    await notifyActiveTab("GAZEAWARE_START_RECORDING");
    didStart = true;
    updateRecordingButtons(true);
    setMessage("Recording");
  } catch (error) {
    setMessage(error.message);
  } finally {
    updateRecordingButtons(didStart);
  }
}

async function stopRecording() {
  clearMessage();
  fields.stopRecording.disabled = true;

  try {
    await chrome.storage.local.set({ isRecording: false });
    await notifyActiveTab("GAZEAWARE_STOP_RECORDING");
    updateRecordingButtons(false);
    setMessage("Stopped");
  } catch (error) {
    setMessage(error.message);
  } finally {
    updateRecordingButtons(false);
  }
}

async function persistSettingsOnly() {
  const setup = collectSetup({ allowEmptyUser: true, allowEmptyTask: true });
  await chrome.storage.local.set(setup);
  await notifyActiveTab("GAZEAWARE_APPLY_VIEWPORT");
}

function collectSetup(options = {}) {
  const userId = normalizeUserId(fields.userId.value);
  const taskId = sanitizePathPart(fields.taskId.value);

  if (!userId && !options.allowEmptyUser) {
    throw new Error("User ID required");
  }
  if (!taskId && !options.allowEmptyTask) {
    throw new Error("Task ID required");
  }

  return {
    enabled: fields.enabled.checked,
    userId,
    taskId,
    viewportWidth: readPositiveInteger(fields.viewportWidth.value, DEFAULT_SETTINGS.viewportWidth),
    viewportHeight: readPositiveInteger(fields.viewportHeight.value, DEFAULT_SETTINGS.viewportHeight),
    scrollStep: readPositiveInteger(fields.scrollStep.value, DEFAULT_SETTINGS.scrollStep)
  };
}

function normalizeUserId(value) {
  return sanitizePathPart(String(value || "").replace(/^user\s*/i, ""));
}

function sanitizePathPart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function writeInitialTaskFiles(setup) {
  const rootHandle = await getStoredRootHandle();
  if (rootHandle && await ensureReadWritePermission(rootHandle)) {
    await writeWithFileSystemAccess(rootHandle, setup);
    return;
  }

  await writeWithDownloads(setup);
}

async function writeWithFileSystemAccess(rootHandle, setup) {
  const taskLogsDir = await rootHandle.getDirectoryHandle("task_logs", { create: true });
  const userDir = await taskLogsDir.getDirectoryHandle(`User ${setup.userId}`, { create: true });
  const taskDir = await userDir.getDirectoryHandle(setup.taskId, { create: true });

  const completedFile = await userDir.getFileHandle("completed_tasks.txt", { create: true });
  const completedText = await readFileHandleText(completedFile);
  const completedLines = completedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!completedLines.includes(setup.taskId)) {
    completedLines.push(setup.taskId);
  }
  await writeFileHandleText(completedFile, `${completedLines.join("\n")}\n`);

  const manifestFile = await taskDir.getFileHandle("setup.json", { create: true });
  await writeFileHandleText(manifestFile, JSON.stringify(createSetupManifest(setup), null, 2));
}

async function writeWithDownloads(setup) {
  const key = `completedTasks:${setup.userId}`;
  const stored = await chrome.storage.local.get({ [key]: [] });
  const completedTasks = Array.isArray(stored[key]) ? stored[key] : [];
  if (!completedTasks.includes(setup.taskId)) {
    completedTasks.push(setup.taskId);
  }

  await chrome.storage.local.set({ [key]: completedTasks });
  await downloadTextFile(
    `task_logs/User ${setup.userId}/completed_tasks.txt`,
    `${completedTasks.join("\n")}\n`
  );
  await downloadTextFile(
    `task_logs/User ${setup.userId}/${setup.taskId}/setup.json`,
    JSON.stringify(createSetupManifest(setup), null, 2)
  );
}

function createSetupManifest(setup) {
  return {
    user_id: setup.userId,
    task_id: setup.taskId,
    created_at: new Date().toISOString(),
    viewport: {
      width: setup.viewportWidth,
      height: setup.viewportHeight,
      scroll_step: setup.scrollStep
    }
  };
}

async function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: "overwrite",
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function notifyActiveTab(messageType = "GAZEAWARE_APPLY_VIEWPORT") {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    return;
  }

  const rootHandle = await getStoredRootHandle();
  if (rootHandle) {
    await ensureReadWritePermission(rootHandle);
  }

  await chrome.runtime.sendMessage({ type: messageType });

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "GAZEAWARE_APPLY_SETTINGS" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["contentScript.js"]
    });
  }
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

async function storeRootHandle(handle) {
  const db = await openDatabase();
  await idbRequest(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(handle, ROOT_HANDLE_KEY));
  db.close();
}

async function getStoredRootHandle() {
  const db = await openDatabase();
  const handle = await idbRequest(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ROOT_HANDLE_KEY));
  db.close();
  return handle || null;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function ensureReadWritePermission(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }
  return (await handle.requestPermission(options)) === "granted";
}

async function readFileHandleText(fileHandle) {
  const file = await fileHandle.getFile();
  return await file.text();
}

async function writeFileHandleText(fileHandle, text) {
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function updateFolderStatus() {
  const handle = await getStoredRootHandle();
  if (!handle) {
    fields.folderStatus.textContent = "No folder selected";
    return;
  }

  const permission = await queryReadWritePermission(handle);
  const permissionText = permission === "granted" ? "write permission granted" : "open settings to grant permission";
  fields.folderStatus.textContent = `Selected: ${handle.name} (${permissionText})`;
}

async function queryReadWritePermission(handle) {
  if (!handle || !handle.queryPermission) {
    return "granted";
  }
  return await handle.queryPermission({ mode: "readwrite" });
}

function setMessage(text) {
  fields.message.textContent = text;
}

function clearMessage() {
  setMessage("");
}

function updateRecordingButtons(isRecording) {
  fields.saveSetup.disabled = Boolean(isRecording);
  fields.stopRecording.disabled = !isRecording;
}
