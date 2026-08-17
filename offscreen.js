const DB_NAME = "gazeaware-recorder";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "logRoot";

let recording = null;
let pendingVideoExport = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "GAZEAWARE_OFFSCREEN_START_VIDEO") {
    startVideo(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "GAZEAWARE_OFFSCREEN_STOP_VIDEO") {
    stopVideo(message.sessionId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "GAZEAWARE_OFFSCREEN_EXPORT_FILES") {
    exportFiles(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

async function startVideo(message) {
  if (recording) throw new Error("A video recording is already active.");
  const downloadsMode = message.storageBackend === "downloads";
  let fileHandle = null;
  let writable = null;
  if (!downloadsMode) {
    const root = await requireWritableRoot();
    const taskDir = await getTaskDirectory(root, message.participantId, message.taskId);
    fileHandle = await taskDir.getFileHandle("screen.webm", { create: true });
    writable = await fileHandle.createWritable();
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    }
  });

  const mimeType = chooseMimeType();
  const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  recording = {
    sessionId: message.sessionId,
    mediaRecorder,
    stream,
    writable,
    fileHandle,
    downloadsMode,
    downloadRoot: message.downloadRoot || "GazeAwareRecorder",
    participantId: message.participantId,
    taskId: message.taskId,
    blobChunks: [],
    writeChain: Promise.resolve(),
    bytes: 0,
    chunks: 0,
    startedAt,
    startedAtMs,
    mimeType: mediaRecorder.mimeType || mimeType || "video/webm",
    error: null
  };

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (!recording || !event.data || event.data.size === 0) return;
    const current = recording;
    current.chunks += 1;
    current.bytes += event.data.size;
    if (current.downloadsMode) current.blobChunks.push(event.data);
    else current.writeChain = current.writeChain.then(() => current.writable.write(event.data)).catch((error) => {
      current.error = error;
    });
  });
  mediaRecorder.addEventListener("error", (event) => {
    if (recording) recording.error = event.error || new Error("MediaRecorder error");
  });
  mediaRecorder.start(1000);

  return {
    file: "screen.webm",
    mime_type: recording.mimeType,
    started_at: startedAt
  };
}

async function stopVideo(sessionId) {
  if (!recording) throw new Error("No video recording is active.");
  if (recording.sessionId !== sessionId) throw new Error("Video session ID does not match.");
  const current = recording;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out while stopping video.")), 10000);
    current.mediaRecorder.addEventListener("stop", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    if (current.mediaRecorder.state === "inactive") {
      clearTimeout(timeout);
      resolve();
    } else {
      current.mediaRecorder.requestData();
      current.mediaRecorder.stop();
    }
  });

  await current.writeChain;
  if (current.writable) await current.writable.close();
  for (const track of current.stream.getTracks()) track.stop();
  const endedAt = new Date().toISOString();
  const expectedDurationMs = Date.now() - current.startedAtMs;
  const videoBlob = current.downloadsMode
    ? new Blob(current.blobChunks, { type: current.mimeType })
    : await current.fileHandle.getFile();
  const validation = await validateVideo(videoBlob, expectedDurationMs);
  if (current.downloadsMode) {
    pendingVideoExport = {
      blob: videoBlob,
      path: `task_logs/User ${sanitizePathPart(current.participantId)}/${sanitizePathPart(current.taskId)}/screen.webm`,
      participantId: sanitizePathPart(current.participantId),
      taskId: sanitizePathPart(current.taskId)
    };
  }
  recording = null;
  if (current.error) throw current.error;
  return {
    file: "screen.webm",
    mime_type: current.mimeType,
    started_at: current.startedAt,
    ended_at: endedAt,
    expected_duration_ms: expectedDurationMs,
    duration_ms: validation.durationMs,
    duration_delta_ms: validation.durationMs === null ? null : Math.abs(validation.durationMs - expectedDurationMs),
    bytes: validation.bytes,
    chunks: current.chunks,
    valid: validation.valid,
    validation_error: validation.error
  };
}

async function validateVideo(file, expectedDurationMs) {
  if (file.size === 0) return { valid: false, bytes: 0, durationMs: null, error: "Empty video file." };
  const url = URL.createObjectURL(file);
  try {
    const metadata = await new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const timeout = setTimeout(() => reject(new Error("Video metadata timeout.")), 10000);
      let decoded = false;
      let fallbackTimer = null;
      const finish = (durationMs, source) => {
        clearTimeout(timeout);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        resolve({ durationMs, decoded, source });
      };
      video.preload = "auto";
      video.muted = true;
      video.addEventListener("loadeddata", () => {
        decoded = true;
      });
      video.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          finish(video.duration * 1000, "container_metadata");
          return;
        }
        const resolveDuration = () => {
          if (!Number.isFinite(video.duration) || video.duration <= 0) return;
          finish(video.duration * 1000, "seek_recovered_metadata");
        };
        video.addEventListener("durationchange", resolveDuration);
        video.addEventListener("seeked", resolveDuration);
        video.currentTime = 1e101;
        fallbackTimer = setTimeout(() => {
          if (decoded) finish(expectedDurationMs, "session_clock_fallback");
        }, 1800);
      }, { once: true });
      video.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Recorded video could not be decoded."));
      }, { once: true });
      video.src = url;
    });
    const duration = metadata.durationMs;
    const valid = duration !== null && duration > 0 && Math.abs(duration - expectedDurationMs) < 5000;
    return {
      valid,
      bytes: file.size,
      durationMs: duration,
      durationSource: metadata.source,
      decoded: metadata.decoded,
      error: valid ? null : "Video decode failed or duration differs from the session by at least 5 seconds."
    };
  } catch (error) {
    return { valid: false, bytes: file.size, durationMs: null, error: error.message };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function exportFiles(message) {
  const root = sanitizePathPart(message.downloadRoot || "GazeAwareRecorder");
  const entries = [];
  for (const item of message.files || []) {
    const content = item.binary ? new Uint8Array(item.content || []) : String(item.content || "");
    entries.push({ path: item.path, bytes: new Uint8Array(await new Blob([content]).arrayBuffer()) });
  }
  if (pendingVideoExport) {
    entries.push({ path: pendingVideoExport.path, bytes: new Uint8Array(await pendingVideoExport.blob.arrayBuffer()) });
  }
  const participant = pendingVideoExport?.participantId || "unknown";
  const task = pendingVideoExport?.taskId || "session";
  const archive = createStoredZip(entries);
  const id = await downloadBlob(archive, `${root}/exports/User_${participant}_${task}.zip`);
  pendingVideoExport = null;
  return { count: entries.length, download_id: id };
}

async function downloadBlob(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  const response = await chrome.runtime.sendMessage({ type: "GAZEAWARE_DOWNLOAD_DATA", filename, dataUrl });
  if (!response?.ok) throw new Error(response?.error || `Could not write ${filename}.`);
  return response.result.id;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not encode recording data."));
    reader.readAsDataURL(blob);
  });
}

function createStoredZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  for (const entry of entries) {
    const name = encoder.encode(entry.path.replace(/^\/+/, ""));
    const data = entry.bytes;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chooseMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function getTaskDirectory(root, participantId, taskId) {
  const logs = await root.getDirectoryHandle("task_logs", { create: true });
  const user = await logs.getDirectoryHandle(`User ${sanitizePathPart(participantId)}`, { create: true });
  return await user.getDirectoryHandle(sanitizePathPart(taskId), { create: true });
}

async function requireWritableRoot() {
  const root = await getStoredRootHandle();
  if (!root) throw new Error("Log Folder is not configured.");
  if (root.queryPermission && await root.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("Log Folder permission is not granted.");
  }
  return root;
}

async function getStoredRootHandle() {
  const db = await openDatabase();
  const handle = await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ROOT_HANDLE_KEY));
  db.close();
  return handle || null;
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

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function sanitizePathPart(value) {
  return String(value || "").trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}
