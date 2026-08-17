const DB_NAME = "gazeaware-recorder";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "logRoot";
const DOWNLOAD_ROOT = "GazeAwareRecorder";

const fields = {
  chooseFolder: document.getElementById("chooseFolder"),
  folderStatus: document.getElementById("folderStatus"),
  message: document.getElementById("message")
};

document.addEventListener("DOMContentLoaded", initialize);
fields.chooseFolder.addEventListener("click", chooseLogFolder);

async function initialize() {
  await updateFolderStatus();
}

async function chooseLogFolder() {
  clearMessage();

  if (!window.showDirectoryPicker) {
    await chrome.storage.local.set({
      storageBackend: "downloads",
      downloadRoot: DOWNLOAD_ROOT,
      logRootName: `Downloads/${DOWNLOAD_ROOT}`,
      logRootUpdatedAt: new Date().toISOString()
    });
    await updateFolderStatus();
    setMessage("Brave fallback enabled. Recordings will be written under Downloads/GazeAwareRecorder.");
    return;
  }

  fields.chooseFolder.disabled = true;

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const hasPermission = await ensureReadWritePermission(handle);
    if (!hasPermission) {
      setMessage("Write permission was not granted");
      await updateFolderStatus(handle);
      return;
    }

    await storeRootHandle(handle);
    await chrome.storage.local.set({
      storageBackend: "filesystem",
      logRootName: handle.name,
      logRootUpdatedAt: new Date().toISOString()
    });
    await updateFolderStatus(handle);
    setMessage("Log folder saved with write permission");
  } catch (error) {
    if (error.name !== "AbortError") {
      setMessage(error.message);
    }
  } finally {
    fields.chooseFolder.disabled = false;
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
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(handle, ROOT_HANDLE_KEY);
    await idbTransaction(transaction);
  } finally {
    db.close();
  }
}

async function getStoredRootHandle() {
  const db = await openDatabase();
  try {
    const handle = await idbRequest(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ROOT_HANDLE_KEY));
    return handle || null;
  } finally {
    db.close();
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
}

async function ensureReadWritePermission(handle) {
  const options = { mode: "readwrite" };
  if (!handle.queryPermission || !handle.requestPermission) {
    return true;
  }
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }
  try {
    return (await handle.requestPermission(options)) === "granted";
  } catch (error) {
    console.warn("requestPermission error:", error);
    return false;
  }
}

async function queryReadWritePermission(handle) {
  if (!handle || !handle.queryPermission) {
    return "granted";
  }
  return await handle.queryPermission({ mode: "readwrite" });
}

async function updateFolderStatus(providedHandle = null) {
  const stored = await chrome.storage.local.get({ storageBackend: null, downloadRoot: DOWNLOAD_ROOT });
  if (stored.storageBackend === "downloads") {
    fields.folderStatus.textContent = `Selected: Downloads/${stored.downloadRoot} (automatic write)`;
    return;
  }
  const handle = providedHandle || await getStoredRootHandle();
  if (!handle) {
    fields.folderStatus.textContent = "No folder selected";
    return;
  }

  const permission = await queryReadWritePermission(handle);
  const permissionText = permission === "granted" ? "write permission granted" : "write permission needed";
  fields.folderStatus.textContent = `Selected: ${handle.name} (${permissionText})`;
}

function setMessage(text) {
  fields.message.textContent = text;
}

function clearMessage() {
  setMessage("");
}
