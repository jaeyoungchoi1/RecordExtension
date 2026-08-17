const DEFAULT_SETTINGS = {
  enabled: true,
  viewportMode: "adaptive",
  viewportWidth: 1080,
  viewportHeight: 720,
  scrollStep: 200,
  userId: "1",
  taskId: "",
  isRecording: false
};

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DB_NAME = "gazeaware-recorder";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "logRoot";
const OFFSCREEN_DOCUMENT = "offscreen.html";
const CHECKPOINT_DELAY_MS = 550;

const attachedTabs = new Set();
const viewportOverrides = new Map();
const pendingNewTabs = new Map();
const checkpointRequests = new Map();
const targetResolutionCache = new Map();
let activeSession = null;
let restorePromise = restoreActiveSession();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  const handlers = {
    GAZEAWARE_APPLY_VIEWPORT: () => applyViewportToActiveTab(),
    GAZEAWARE_START_SESSION: () => startSession(message.setup, message.tabId, message.streamId),
    GAZEAWARE_STOP_SESSION: () => stopSession(message.outcome || {}),
    GAZEAWARE_INTERACTION: () => receiveInteraction(sender.tab?.id, message.interaction),
    GAZEAWARE_VIDEO_STATUS: () => receiveVideoStatus(message.status),
    GAZEAWARE_DOWNLOAD_DATA: () => downloadDataUrl(message)
  };

  const handler = handlers[message.type];
  if (!handler) return false;

  Promise.resolve(handler())
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  handleCreatedTab(tab).catch((error) => noteRuntimeFailure("tab_created", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handleTabUpdate(tabId, changeInfo, tab).catch((error) => noteRuntimeFailure("tab_updated", error));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  recordSystemEvent("tab_activated", activeInfo.tabId, { window_id: activeInfo.windowId }, false)
    .catch((error) => noteRuntimeFailure("tab_activated", error));
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  attachedTabs.delete(tabId);
  viewportOverrides.delete(tabId);
  pendingNewTabs.delete(tabId);
  clearCheckpointRequest(tabId);
  recordSystemEvent("tab_closed", tabId, { window_id: removeInfo.windowId }, false)
    .catch((error) => noteRuntimeFailure("tab_closed", error));
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const historyTraversal = Array.isArray(details.transitionQualifiers) && details.transitionQualifiers.includes("forward_back");
  recordSystemEvent(historyTraversal ? "browser_history_navigation" : "navigation_committed", details.tabId, {
    url: details.url,
    transition_type: details.transitionType,
    transition_qualifiers: details.transitionQualifiers
  }, true).catch((error) => noteRuntimeFailure("navigation_committed", error));
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    viewportOverrides.delete(source.tabId);
  }
});

async function startSession(rawSetup, requestedTabId, streamId) {
  await restorePromise;
  if (activeSession) throw new Error("A recording session is already active.");

  let setup = normalizeSetup(rawSetup);
  const tab = requestedTabId ? await chrome.tabs.get(requestedTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !isWebUrl(tab.url)) throw new Error("Open an http(s) task page before starting.");
  if (!streamId) throw new Error("Unable to obtain the browser-tab video stream.");
  if (setup.viewportMode === "adaptive") setup = await resolveAdaptiveViewport(tab.id, setup);

  const storage = await requireStorageBackend();
  const rootHandle = storage.rootHandle || null;
  const startedAt = new Date().toISOString();
  const sessionId = `${compactTimestamp(startedAt)}_${randomId()}`;
  activeSession = {
    sessionId,
    participantId: setup.userId,
    taskId: setup.taskId,
    taskNumber: setup.taskNumber,
    taskSite: setup.taskSite,
    taskTitle: setup.taskTitle,
    taskUrl: setup.taskUrl,
    taskCatalogVersion: setup.taskCatalogVersion,
    taskPrompt: setup.taskPrompt,
    taskPromptHash: await sha256(setup.taskPrompt || ""),
    taskVersion: setup.taskVersion,
    environmentType: setup.environmentType,
    synthetic: setup.synthetic,
    tabId: tab.id,
    startedAt,
    endedAt: null,
    status: "recording",
    eventCount: 0,
    stateCount: 0,
    writeFailures: [],
    lastStateId: null,
    lastUrl: tab.url,
    lastScroll: { x: 0, y: 0 },
    documentSequence: 1,
    viewport: {
      width: setup.viewportWidth,
      height: setup.viewportHeight,
      mode: setup.viewportMode,
      detected: setup.viewportDetected,
      device_scale_factor: setup.viewportDetected?.device_pixel_ratio || 1,
      browser_zoom: 1,
      scroll_step: setup.scrollStep
    },
    video: { status: "starting", file: "screen.webm" },
    outcome: null,
    extensionVersion: chrome.runtime.getManifest().version,
    queue: Promise.resolve(),
    rootHandle,
    storageBackend: storage.type,
    downloadRoot: storage.downloadRoot || null,
    downloadFiles: new Map()
  };

  try {
    await createSessionDirectories();
    await writeTaskFile("events.jsonl", "");
    await chrome.storage.local.set({
      ...setup,
      isRecording: true,
      activeSession: serializableSession(activeSession)
    });
    if (setup.enabled) await applyViewportToTab(tab.id, setup);
    else await prepareDebuggerDomains({ tabId: tab.id });
    await notifyTabSettings(tab.id);
    await writeSessionManifest();

    await ensureOffscreenDocument();
    const videoResponse = await chrome.runtime.sendMessage({
      type: "GAZEAWARE_OFFSCREEN_START_VIDEO",
      streamId,
      participantId: setup.userId,
      taskId: setup.taskId,
      sessionId,
      storageBackend: storage.type,
      downloadRoot: storage.downloadRoot || null
    });
    if (!videoResponse?.ok) throw new Error(videoResponse?.error || "Video recording did not start.");
    activeSession.video = { ...activeSession.video, status: "recording", ...videoResponse.result };

    await enqueue(async () => {
      await appendEvent({
        type: "session_start",
        source: "recorder",
        tab_id: tab.id,
        url: tab.url,
        state_before_id: null,
        setup: publicSetup(setup)
      });
      await captureCheckpoint(tab.id, ["session_start"], []);
      await writeSessionManifest();
    });
    return { session_id: sessionId, folder: taskRelativeFolder(), video: activeSession.video };
  } catch (error) {
    await failStart(error);
    throw error;
  }
}

async function stopSession(outcome) {
  await restorePromise;
  if (!activeSession) throw new Error("No recording session is active.");

  const session = activeSession;
  session.outcome = normalizeOutcome(outcome);

  try {
    await flushCheckpointRequest(session.tabId);
    await enqueue(async () => {
      await captureCheckpoint(session.tabId, ["session_end"], []);
      await appendEvent({
        type: "session_stop",
        source: "recorder",
        tab_id: session.tabId,
        url: session.lastUrl,
        state_before_id: session.lastStateId,
        outcome: session.outcome
      });
    });
  } catch (error) {
    session.writeFailures.push({ stage: "final_checkpoint", error: error.message, timestamp: new Date().toISOString() });
  }

  let videoResult;
  try {
    const response = await chrome.runtime.sendMessage({ type: "GAZEAWARE_OFFSCREEN_STOP_VIDEO", sessionId: session.sessionId });
    if (!response?.ok) throw new Error(response?.error || "Video stop failed.");
    videoResult = response.result;
    session.video = { ...session.video, ...videoResult, status: videoResult.valid ? "valid" : "invalid" };
  } catch (error) {
    session.video = { ...session.video, status: "failed", error: error.message };
    session.writeFailures.push({ stage: "video_stop", error: error.message, timestamp: new Date().toISOString() });
  }

  session.endedAt = new Date().toISOString();
  let qa = buildQa(session);
  session.status = qa.passed ? "completed" : "failed";
  try {
    await writeTaskFile("qa.json", JSON.stringify(qa, null, 2));
    await writeSessionManifest();
  } catch (_error) {
    session.status = "failed";
  }
  qa = buildQa(session);
  session.status = qa.passed ? "completed" : "failed";
  try {
    await writeTaskFile("qa.json", JSON.stringify(qa, null, 2));
    await writeSessionManifest();
  } catch (_error) {
    session.status = "failed";
    qa = buildQa(session);
  }
  if (session.status === "completed") {
    try {
      await markTaskCompleted(session.participantId, session.taskId);
    } catch (error) {
      session.writeFailures.push({ stage: "mark_completed", error: error.message, timestamp: new Date().toISOString() });
      session.status = "failed";
      qa = buildQa(session);
      await writeTaskFile("qa.json", JSON.stringify(qa, null, 2)).catch(() => {});
      await writeSessionManifest().catch(() => {});
    }
  }

  if (session.storageBackend === "downloads") {
    try {
      await flushDownloadFiles(session);
    } catch (error) {
      session.writeFailures.push({ stage: "downloads_flush", error: error.message, timestamp: new Date().toISOString() });
      session.status = "failed";
      qa = buildQa(session);
    }
  }

  const result = {
    session_id: session.sessionId,
    status: session.status,
    event_count: session.eventCount,
    state_count: session.stateCount,
    video: session.video,
    qa
  };

  clearCheckpointRequest(session.tabId);
  activeSession = null;
  await chrome.storage.local.set({ isRecording: false, activeSession: null, lastSessionResult: result });
  await notifyTabSettings(session.tabId).catch(() => {});
  return result;
}

async function failStart(error) {
  if (!activeSession) return;
  activeSession.status = "failed";
  activeSession.endedAt = new Date().toISOString();
  activeSession.writeFailures.push({ stage: "session_start", error: error.message, timestamp: activeSession.endedAt });
  await writeSessionManifest().catch(() => {});
  await chrome.runtime.sendMessage({ type: "GAZEAWARE_OFFSCREEN_STOP_VIDEO", sessionId: activeSession.sessionId }).catch(() => {});
  activeSession = null;
  await chrome.storage.local.set({ isRecording: false, activeSession: null });
}

async function receiveInteraction(tabId, rawInteraction) {
  await restorePromise;
  if (!activeSession || tabId !== activeSession.tabId || !rawInteraction?.type) return null;

  return await enqueue(async () => {
    const interaction = sanitizeInteraction(rawInteraction);
    if (interaction.target?.selector) {
      interaction.target = await enrichTargetWithBrowserIds(tabId, interaction.target);
    }
    const event = await appendEvent({
      ...interaction,
      source: "web",
      tab_id: tabId,
      document_id: documentId(tabId),
      state_before_id: activeSession.lastStateId
    });
    if (rawInteraction.current_url || rawInteraction.url) activeSession.lastUrl = rawInteraction.current_url || rawInteraction.url;
    if (rawInteraction.scroll_after) activeSession.lastScroll = rawInteraction.scroll_after;
    else if (rawInteraction.scroll) activeSession.lastScroll = rawInteraction.scroll;
    if (rawInteraction.checkpoint) {
      scheduleCheckpoint(
        tabId,
        rawInteraction.type,
        event.event_id,
        positiveInteger(rawInteraction.checkpoint_delay_ms, CHECKPOINT_DELAY_MS)
      );
    }
    return { event_id: event.event_id };
  });
}

async function recordSystemEvent(type, tabId, details = {}, checkpoint = false) {
  await restorePromise;
  if (!activeSession || tabId !== activeSession.tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await enqueue(async () => {
    const event = await appendEvent({
      type,
      source: "browser",
      tab_id: tabId,
      document_id: documentId(tabId),
      state_before_id: activeSession.lastStateId,
      url: details.url || tab?.url || activeSession.lastUrl,
      ...details
    });
    if (details.url) activeSession.lastUrl = details.url;
    if (type === "navigation_committed" || type === "browser_history_navigation") activeSession.documentSequence += 1;
    if (type === "navigation_committed" || type === "browser_history_navigation") targetResolutionCache.clear();
    if (checkpoint) scheduleCheckpoint(tabId, type, event.event_id, 800);
  });
}

async function handleTabUpdate(tabId, changeInfo, tab) {
  await restorePromise;
  if (pendingNewTabs.has(tabId) && isWebUrl(tab.url)) {
    await redirectNewTabToOpener(tabId, pendingNewTabs.get(tabId), tab.url);
    return;
  }
  if (!activeSession || tabId !== activeSession.tabId) return;

  if (changeInfo.url) {
    await recordSystemEvent("tab_url_changed", tabId, { url: changeInfo.url }, true);
  }
  if (changeInfo.status === "complete" && isWebUrl(tab.url)) {
    const settings = await getSettings();
    if (settings.enabled) await applyViewportToTab(tabId, settings);
    await notifyTabSettings(tabId);
    scheduleCheckpoint(tabId, "page_load_complete", null, 900);
  }
}

async function handleCreatedTab(tab) {
  await restorePromise;
  if (!activeSession || !tab.openerTabId) return;
  await recordSystemEvent("tab_created", activeSession.tabId, {
    created_tab_id: tab.id,
    opener_tab_id: tab.openerTabId,
    pending_url: tab.pendingUrl || tab.url || null
  }, false);
  if (tab.openerTabId !== activeSession.tabId) return;
  const url = tab.pendingUrl || tab.url;
  if (isWebUrl(url)) await redirectNewTabToOpener(tab.id, tab.openerTabId, url);
  else pendingNewTabs.set(tab.id, tab.openerTabId);
}

async function redirectNewTabToOpener(newTabId, openerTabId, url) {
  if (!isWebUrl(url)) return;
  pendingNewTabs.delete(newTabId);
  await recordSystemEvent("new_tab_redirected", openerTabId, { created_tab_id: newTabId, url }, true);
  await chrome.tabs.update(openerTabId, { url, active: true });
  await chrome.tabs.remove(newTabId).catch(() => {});
}

function scheduleCheckpoint(tabId, reason, eventId, delayMs = CHECKPOINT_DELAY_MS) {
  if (!activeSession || tabId !== activeSession.tabId) return;
  const pending = checkpointRequests.get(tabId) || { reasons: new Set(), eventIds: new Set(), timer: null };
  pending.reasons.add(reason);
  if (eventId) pending.eventIds.add(eventId);
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    checkpointRequests.delete(tabId);
    enqueue(() => captureCheckpoint(tabId, Array.from(pending.reasons), Array.from(pending.eventIds)))
      .catch((error) => noteRuntimeFailure("checkpoint", error));
  }, delayMs);
  checkpointRequests.set(tabId, pending);
}

async function flushCheckpointRequest(tabId) {
  const pending = checkpointRequests.get(tabId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  checkpointRequests.delete(tabId);
  await enqueue(() => captureCheckpoint(tabId, Array.from(pending.reasons), Array.from(pending.eventIds)));
}

function clearCheckpointRequest(tabId) {
  const pending = checkpointRequests.get(tabId);
  if (pending?.timer) clearTimeout(pending.timer);
  checkpointRequests.delete(tabId);
}

async function captureCheckpoint(tabId, reasons, triggerEventIds) {
  if (!activeSession || tabId !== activeSession.tabId) return null;
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !isWebUrl(tab.url)) return null;

  const settings = await getSettings();
  const target = { tabId };
  if (settings.enabled) await applyViewportToTab(tabId, settings);
  else await prepareDebuggerDomains(target);
  await waitForPageStable(target);

  const stateNumber = activeSession.stateCount + 1;
  const stateId = `state_${String(stateNumber).padStart(4, "0")}`;
  const capturedAt = new Date().toISOString();

  const [title, html, css, domSnapshot, axTree, screenshot, context] = await Promise.all([
    getPageTitle(target, tab),
    captureHtml(target),
    captureCss(target),
    captureDomTree(target),
    captureA11yTree(target),
    captureScreenshot(target),
    capturePageContext(target)
  ]);

  if (
    activeSession.stateCount === 0 &&
    activeSession.viewport.mode === "adaptive" &&
    context.viewport?.width &&
    context.viewport?.height
  ) {
    activeSession.viewport.width = context.viewport.width;
    activeSession.viewport.height = context.viewport.height;
    activeSession.viewport.device_scale_factor = context.viewport.device_pixel_ratio || 1;
    activeSession.viewport.detected = {
      width: context.viewport.width,
      height: context.viewport.height,
      device_pixel_ratio: context.viewport.device_pixel_ratio || 1,
      detected_at: capturedAt
    };
  }

  const [htmlAsset, cssAsset, domAsset, axAsset] = await Promise.all([
    writeHashedAsset("dom", "html", html),
    writeHashedAsset("css", "css", css),
    writeHashedAsset("dom_snapshot", "json", JSON.stringify(domSnapshot)),
    writeHashedAsset("ax", "json", JSON.stringify(axTree))
  ]);

  const screenshotFile = `states/${stateId}.png`;
  await writeTaskFile(screenshotFile, base64ToUint8Array(screenshot), { binary: true });

  const stateRecord = {
    state_id: stateId,
    previous_state_id: activeSession.lastStateId,
    captured_at: capturedAt,
    timestamp_ms: Date.now(),
    reasons,
    trigger_event_ids: triggerEventIds,
    tab_id: tabId,
    document_id: documentId(tabId),
    url: tab.url,
    title,
    viewport: context.viewport,
    scroll: context.scroll,
    focused_element: context.focused,
    screenshot_file: screenshotFile,
    html_asset: htmlAsset,
    css_asset: cssAsset,
    dom_snapshot_asset: domAsset,
    a11y_asset: axAsset
  };
  await writeTaskFile(`states/${stateId}.json`, JSON.stringify(stateRecord, null, 2));

  activeSession.stateCount = stateNumber;
  activeSession.lastStateId = stateId;
  activeSession.lastUrl = tab.url;
  activeSession.lastScroll = context.scroll;
  await appendEvent({
    type: "checkpoint_created",
    source: "recorder",
    tab_id: tabId,
    document_id: stateRecord.document_id,
    url: tab.url,
    viewport: context.viewport,
    scroll: context.scroll,
    state_before_id: stateRecord.previous_state_id,
    state_after_id: stateId,
    trigger_event_ids: triggerEventIds,
    reasons
  });
  await persistSession();
  return stateRecord;
}

async function appendEvent(event) {
  if (!activeSession) throw new Error("No active session for event write.");
  const eventId = `event_${String(activeSession.eventCount + 1).padStart(6, "0")}`;
  const now = Date.now();
  const record = {
    event_id: eventId,
    timestamp: event.timestamp || new Date(now).toISOString(),
    timestamp_ms: Number.isFinite(Number(event.timestamp_ms)) ? Number(event.timestamp_ms) : now,
    session_elapsed_ms: now - Date.parse(activeSession.startedAt),
    state_before_id: event.state_before_id ?? activeSession.lastStateId,
    state_after_id: event.state_after_id ?? null,
    tab_id: event.tab_id ?? activeSession.tabId,
    document_id: event.document_id ?? documentId(activeSession.tabId),
    url: event.url || activeSession.lastUrl,
    viewport: event.viewport || activeSession.viewport,
    scroll: event.scroll || activeSession.lastScroll || null,
    pointer: event.pointer || null,
    key: event.key || null,
    target: event.target || null,
    ...event
  };
  delete record.checkpoint;
  delete record.checkpoint_delay_ms;
  await appendTaskText("events.jsonl", `${JSON.stringify(record)}\n`);
  activeSession.eventCount += 1;
  await persistSession();
  return record;
}

async function writeHashedAsset(kind, extension, content) {
  const hash = await sha256(content);
  const relative = `assets/${kind}/${hash}.${extension}`;
  await writeTaskFile(relative, content);
  return { sha256: hash, file: relative };
}

async function captureHtml(target) {
  const result = await sendCommand(target, "Runtime.evaluate", {
    expression: `document.documentElement ? "<!doctype html>\\n" + document.documentElement.outerHTML : ""`,
    returnByValue: true
  });
  return result.result?.value || "";
}

async function enrichTargetWithBrowserIds(tabId, targetDescription) {
  const cacheKey = `${documentId(tabId)}:${targetDescription.selector}`;
  if (targetResolutionCache.has(cacheKey)) {
    return { ...targetDescription, ...targetResolutionCache.get(cacheKey) };
  }
  const cdpTarget = { tabId };
  try {
    await prepareDebuggerDomains(cdpTarget);
    const evaluated = await sendCommand(cdpTarget, "Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(targetDescription.selector)})`,
      returnByValue: false
    });
    const objectId = evaluated?.result?.objectId;
    if (!objectId) return targetDescription;
    const [described, partialAx] = await Promise.all([
      sendCommand(cdpTarget, "DOM.describeNode", { objectId, depth: 0, pierce: true }),
      sendCommand(cdpTarget, "Accessibility.getPartialAXTree", { objectId, fetchRelatives: false }).catch(() => ({ nodes: [] }))
    ]);
    await sendCommand(cdpTarget, "Runtime.releaseObject", { objectId }).catch(() => {});
    const resolution = {
      dom_node_id: described?.node?.nodeId || null,
      dom_backend_node_id: described?.node?.backendNodeId || null,
      ax_node_ids: (partialAx.nodes || []).map((node) => node.nodeId),
      browser_accessible_role: partialAx.nodes?.[0]?.role?.value || null,
      browser_accessible_name: partialAx.nodes?.[0]?.name?.value || null
    };
    targetResolutionCache.set(cacheKey, resolution);
    return { ...targetDescription, ...resolution };
  } catch (error) {
    return { ...targetDescription, browser_id_resolution_error: error.message };
  }
}

async function captureCss(target) {
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
  return result?.result?.value || "";
}

async function captureDomTree(target) {
  return await sendCommand(target, "DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includePaintOrder: true,
    includeDOMRects: true,
    includeBlendedBackgroundColors: false,
    includeTextColorOpacities: false
  }).catch((error) => ({ error: error.message, documents: [], strings: [] }));
}

async function captureA11yTree(target) {
  return await sendCommand(target, "Accessibility.getFullAXTree").catch((error) => ({ error: error.message, nodes: [] }));
}

async function captureScreenshot(target) {
  await waitForNextFrame(target);
  const result = await sendCommand(target, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  if (!result.data) throw new Error("Screenshot capture returned no data.");
  return result.data;
}

async function capturePageContext(target) {
  const result = await sendCommand(target, "Runtime.evaluate", {
    expression: `
      (() => {
        const el = document.activeElement;
        const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return {
          viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
          scroll: { x: scrollX || 0, y: scrollY || 0 },
          focused: el ? {
            tag: el.tagName,
            id: el.id || null,
            role: el.getAttribute && el.getAttribute("role"),
            aria_label: el.getAttribute && el.getAttribute("aria-label"),
            bounds: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
          } : null
        };
      })()
    `,
    returnByValue: true
  }).catch(() => null);
  return result?.result?.value || { viewport: null, scroll: null, focused: null };
}

async function waitForPageStable(target) {
  await sendCommand(target, "Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (document.readyState === "complete") {
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(done).catch(done);
        else done();
      } else {
        addEventListener("load", done, { once: true });
        setTimeout(done, 1400);
      }
    })`,
    awaitPromise: true,
    returnByValue: true
  }).catch(() => {});
  await sleep(180);
}

async function waitForNextFrame(target) {
  await sendCommand(target, "Runtime.evaluate", {
    expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
    returnByValue: true
  }).catch(() => {});
}

async function getPageTitle(target, tab) {
  const result = await sendCommand(target, "Runtime.evaluate", { expression: "document.title", returnByValue: true }).catch(() => null);
  return result?.result?.value || tab.title || "";
}

async function applyViewportToActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isWebUrl(tab.url)) return;
  const settings = await getSettings();
  if (settings.enabled) await applyViewportToTab(tab.id, settings);
  else await clearViewportForTab(tab.id);
}

async function resolveAdaptiveViewport(tabId, setup) {
  const target = { tabId };
  await prepareDebuggerDomains(target);
  const result = await sendCommand(target, "Runtime.evaluate", {
    expression: `({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    })`,
    returnByValue: true
  });
  const detected = result?.result?.value || {};
  const width = positiveInteger(detected.width, 0);
  const height = positiveInteger(detected.height, 0);
  if (!width || !height) throw new Error("Unable to detect the active tab viewport.");
  return {
    ...setup,
    viewportWidth: width,
    viewportHeight: height,
    viewportDetected: {
      width,
      height,
      device_pixel_ratio: Number.isFinite(detected.devicePixelRatio) ? detected.devicePixelRatio : 1,
      detected_at: new Date().toISOString()
    }
  };
}

async function applyViewportToTab(tabId, settings) {
  const target = { tabId };
  await prepareDebuggerDomains(target);
  if (settings.viewportMode !== "manual") {
    if (viewportOverrides.has(tabId)) {
      await sendCommand(target, "Emulation.setScrollbarsHidden", { hidden: false }).catch(() => {});
      await sendCommand(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});
      viewportOverrides.delete(tabId);
    }
    return;
  }

  const width = positiveInteger(settings.viewportWidth, DEFAULT_SETTINGS.viewportWidth);
  const height = positiveInteger(settings.viewportHeight, DEFAULT_SETTINGS.viewportHeight);
  const signature = `${width}x${height}`;
  if (viewportOverrides.get(tabId) === signature) return;

  await chrome.tabs.setZoom(tabId, 1).catch(() => {});
  await sendCommand(target, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
    positionX: 0,
    positionY: 0,
    scale: 1
  });
  await sendCommand(target, "Emulation.setVisibleSize", {
    width,
    height
  });
  await sendCommand(target, "Emulation.setScrollbarsHidden", { hidden: true }).catch(() => {});
  viewportOverrides.set(tabId, signature);
}

async function clearViewportForTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  const target = { tabId };
  await sendCommand(target, "Emulation.setScrollbarsHidden", { hidden: false }).catch(() => {});
  await sendCommand(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});
  await chrome.debugger.detach(target).catch(() => {});
  attachedTabs.delete(tabId);
  viewportOverrides.delete(tabId);
}

async function prepareDebuggerDomains(target) {
  if (!attachedTabs.has(target.tabId)) {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attachedTabs.add(target.tabId);
  }
  await sendCommand(target, "Page.enable");
  await sendCommand(target, "Runtime.enable");
  await sendCommand(target, "DOM.enable").catch(() => {});
  await sendCommand(target, "Accessibility.enable").catch(() => {});
}

async function sendCommand(target, method, params = {}) {
  return await chrome.debugger.sendCommand(target, method, params);
}

async function notifyTabSettings(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "GAZEAWARE_APPLY_SETTINGS" });
  } catch (_error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["contentScript.js"] });
  }
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })
    : [];
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ["USER_MEDIA"],
    justification: "Record the controlled browser viewport for the research session."
  });
}

async function receiveVideoStatus(status) {
  await restorePromise;
  if (!activeSession || status?.session_id !== activeSession.sessionId) return;
  activeSession.video = { ...activeSession.video, ...status };
  await persistSession();
}

async function createSessionDirectories() {
  if (activeSession?.storageBackend === "downloads") return;
  const taskDir = await getTaskDirectory(true);
  for (const path of ["states", "assets/css", "assets/dom", "assets/dom_snapshot", "assets/ax"]) {
    await getDirectory(taskDir, path.split("/"), true);
  }
}

async function writeTaskFile(relativePath, content, options = {}) {
  try {
    if (activeSession?.storageBackend === "downloads") {
      activeSession.downloadFiles.set(relativePath, {
        binary: Boolean(options.binary),
        content: options.binary ? Array.from(content) : String(content)
      });
      return;
    }
    const taskDir = await getTaskDirectory(true);
    const parts = relativePath.split("/").filter(Boolean);
    const filename = parts.pop();
    const directory = await getDirectory(taskDir, parts, true);
    const handle = await directory.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(options.binary ? content : String(content));
    await writable.close();
  } catch (error) {
    if (activeSession) activeSession.writeFailures.push({ stage: "write", file: relativePath, error: error.message, timestamp: new Date().toISOString() });
    throw error;
  }
}

async function appendTaskText(relativePath, text) {
  try {
    if (activeSession?.storageBackend === "downloads") {
      const existing = activeSession.downloadFiles.get(relativePath);
      activeSession.downloadFiles.set(relativePath, {
        binary: false,
        content: `${existing?.content || ""}${text}`
      });
      return;
    }
    const taskDir = await getTaskDirectory(true);
    const parts = relativePath.split("/").filter(Boolean);
    const filename = parts.pop();
    const directory = await getDirectory(taskDir, parts, true);
    const handle = await directory.getFileHandle(filename, { create: true });
    const file = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(file.size);
    await writable.write(text);
    await writable.close();
  } catch (error) {
    if (activeSession) activeSession.writeFailures.push({ stage: "append", file: relativePath, error: error.message, timestamp: new Date().toISOString() });
    throw error;
  }
}

async function getTaskDirectory(create = false) {
  if (!activeSession) throw new Error("No active session directory.");
  const root = activeSession.rootHandle || await requireWritableRoot();
  activeSession.rootHandle = root;
  const logs = await root.getDirectoryHandle("task_logs", { create });
  const user = await logs.getDirectoryHandle(`User ${activeSession.participantId}`, { create });
  return await user.getDirectoryHandle(activeSession.taskId, { create });
}

async function getDirectory(parent, parts, create) {
  let current = parent;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create });
  return current;
}

async function markTaskCompleted(participantId, taskId) {
  if (activeSession?.storageBackend === "downloads") {
    activeSession.downloadFiles.set("../completed_tasks.txt", { binary: false, content: `${taskId}\n` });
    return;
  }
  const root = activeSession?.rootHandle || await requireWritableRoot();
  const logs = await root.getDirectoryHandle("task_logs", { create: true });
  const user = await logs.getDirectoryHandle(`User ${participantId}`, { create: true });
  const handle = await user.getFileHandle("completed_tasks.txt", { create: true });
  const file = await handle.getFile();
  const lines = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.includes(taskId)) lines.push(taskId);
  const writable = await handle.createWritable();
  await writable.write(`${lines.join("\n")}\n`);
  await writable.close();
}

async function writeSessionManifest() {
  if (!activeSession) return;
  await writeTaskFile("session.json", JSON.stringify({
    schema_version: "1.0",
    session_id: activeSession.sessionId,
    participant_id: activeSession.participantId,
    task_id: activeSession.taskId,
    task: {
      number: activeSession.taskNumber,
      site: activeSession.taskSite,
      title: activeSession.taskTitle,
      start_url: activeSession.taskUrl,
      catalog_version: activeSession.taskCatalogVersion
    },
    task_prompt: activeSession.taskPrompt,
    task_prompt_sha256: activeSession.taskPromptHash,
    task_version: activeSession.taskVersion,
    environment_type: activeSession.environmentType,
    synthetic: activeSession.synthetic,
    started_at: activeSession.startedAt,
    ended_at: activeSession.endedAt,
    duration_ms: activeSession.endedAt ? Date.parse(activeSession.endedAt) - Date.parse(activeSession.startedAt) : null,
    status: activeSession.status,
    outcome: activeSession.outcome,
    viewport: activeSession.viewport,
    browser: {
      user_agent: globalThis.navigator?.userAgent || null,
      extension_version: activeSession.extensionVersion
    },
    storage: {
      backend: activeSession.storageBackend,
      root: activeSession.storageBackend === "downloads" ? `Downloads/${activeSession.downloadRoot}` : "selected_directory"
    },
    counts: {
      events: activeSession.eventCount,
      states: activeSession.stateCount,
      screenshots: activeSession.stateCount,
      write_failures: activeSession.writeFailures.length
    },
    video: activeSession.video,
    files: {
      events: "events.jsonl",
      states: "states/",
      assets: "assets/",
      qa: activeSession.endedAt ? "qa.json" : null
    },
    write_failures: activeSession.writeFailures
  }, null, 2));
}

function buildQa(session) {
  const checks = {
    session_has_start_and_end: Boolean(session.startedAt && session.endedAt),
    has_events: session.eventCount >= 2,
    has_initial_and_final_state: session.stateCount >= 2,
    video_file_written: Boolean(session.video?.bytes > 0),
    video_metadata_valid: Boolean(session.video?.valid && session.video?.duration_ms > 0),
    no_write_failures: session.writeFailures.length === 0
  };
  return {
    generated_at: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    checks,
    counts: { events: session.eventCount, states: session.stateCount, write_failures: session.writeFailures.length },
    video: session.video,
    failures: session.writeFailures
  };
}

async function restoreActiveSession() {
  const stored = await chrome.storage.local.get({ activeSession: null, isRecording: false });
  if (!stored.isRecording || !stored.activeSession) return;
  const storage = await requireStorageBackend().catch(() => null);
  if (!storage || storage.type === "downloads") {
    await chrome.storage.local.set({ isRecording: false, activeSession: null });
    return;
  }
  activeSession = {
    ...stored.activeSession,
    queue: Promise.resolve(),
    rootHandle,
    writeFailures: Array.isArray(stored.activeSession.writeFailures) ? stored.activeSession.writeFailures : []
  };
}

async function persistSession() {
  if (!activeSession) return;
  await chrome.storage.local.set({ activeSession: serializableSession(activeSession) });
}

function serializableSession(session) {
  const copy = { ...session };
  delete copy.queue;
  delete copy.rootHandle;
  delete copy.downloadFiles;
  return copy;
}

function enqueue(operation) {
  if (!activeSession) return Promise.reject(new Error("No active session."));
  const run = activeSession.queue.then(operation, operation);
  activeSession.queue = run.catch(() => {});
  return run;
}

async function noteRuntimeFailure(stage, error) {
  await restorePromise;
  if (!activeSession) return;
  activeSession.writeFailures.push({ stage, error: error.message, timestamp: new Date().toISOString() });
  await persistSession().catch(() => {});
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSetup(stored, { allowEmpty: true });
}

function normalizeSetup(raw = {}, options = {}) {
  const userId = sanitizePathPart(raw.userId);
  const taskId = sanitizePathPart(raw.taskId);
  if (!options.allowEmpty && (!userId || !taskId)) throw new Error("Participant ID and Task ID are required.");
  return {
    enabled: Boolean(raw.enabled),
    userId,
    taskId,
    taskNumber: positiveInteger(raw.taskNumber, positiveInteger(taskId, 0)) || null,
    taskSite: String(raw.taskSite || "").trim() || null,
    taskTitle: String(raw.taskTitle || "").trim() || null,
    taskUrl: String(raw.taskUrl || "").trim() || null,
    taskCatalogVersion: String(raw.taskCatalogVersion || "").trim() || null,
    viewportMode: raw.viewportMode === "manual" ? "manual" : "adaptive",
    viewportWidth: positiveInteger(raw.viewportWidth, DEFAULT_SETTINGS.viewportWidth),
    viewportHeight: positiveInteger(raw.viewportHeight, DEFAULT_SETTINGS.viewportHeight),
    viewportDetected: raw.viewportDetected && typeof raw.viewportDetected === "object" ? raw.viewportDetected : null,
    scrollStep: positiveInteger(raw.scrollStep, DEFAULT_SETTINGS.scrollStep),
    environmentType: raw.environmentType === "synthetic" ? "synthetic" : "real",
    taskPrompt: String(raw.taskPrompt || "").trim(),
    taskVersion: String(raw.taskVersion || "").trim() || "unspecified",
    synthetic: {
      app_version: String(raw.syntheticAppVersion || "").trim() || null,
      dataset_version: String(raw.datasetVersion || "").trim() || null,
      seed: String(raw.datasetSeed || "").trim() || null,
      db_start_snapshot_id: String(raw.dbStartSnapshotId || "").trim() || null
    }
  };
}

function publicSetup(setup) {
  return {
    participant_id: setup.userId,
    task_id: setup.taskId,
    task: {
      number: setup.taskNumber,
      site: setup.taskSite,
      title: setup.taskTitle,
      start_url: setup.taskUrl,
      catalog_version: setup.taskCatalogVersion
    },
    environment_type: setup.environmentType,
    task_version: setup.taskVersion,
    viewport: {
      width: setup.viewportWidth,
      height: setup.viewportHeight,
      mode: setup.viewportMode,
      detected: setup.viewportDetected,
      scroll_step: setup.scrollStep
    },
    synthetic: setup.synthetic
  };
}

function normalizeOutcome(raw) {
  const status = ["success", "failure", "aborted", "unknown"].includes(raw.status) ? raw.status : "unknown";
  return {
    status,
    final_choice: String(raw.finalChoice || "").trim() || null,
    db_end_snapshot_id: String(raw.dbEndSnapshotId || "").trim() || null,
    notes: String(raw.notes || "").trim() || null
  };
}

function sanitizeInteraction(raw) {
  const clean = { ...raw };
  if (clean.target?.value === "[REDACTED]") clean.value = "[REDACTED]";
  return clean;
}

function documentId(tabId) {
  return `tab_${tabId}_document_${activeSession?.documentSequence || 1}`;
}

function taskRelativeFolder() {
  return `task_logs/User ${activeSession.participantId}/${activeSession.taskId}`;
}

async function requireStorageBackend() {
  const stored = await chrome.storage.local.get({ storageBackend: null, downloadRoot: "GazeAwareRecorder" });
  if (stored.storageBackend === "downloads") {
    return { type: "downloads", downloadRoot: sanitizePathPart(stored.downloadRoot || "GazeAwareRecorder") };
  }
  const root = await getStoredRootHandle();
  if (!root) throw new Error("Choose a Log Folder before starting.");
  if (!(await hasReadWritePermission(root))) throw new Error("Log Folder permission expired. Open Log Folder settings and grant access again.");
  return { type: "filesystem", rootHandle: root };
}

async function requireWritableRoot() {
  const storage = await requireStorageBackend();
  if (storage.type !== "filesystem") throw new Error("Filesystem storage is not active.");
  return storage.rootHandle;
}

async function flushDownloadFiles(session) {
  const files = [];
  for (const [relativePath, record] of session.downloadFiles.entries()) {
    const normalized = relativePath === "../completed_tasks.txt"
      ? `task_logs/User ${session.participantId}/completed_tasks.txt`
      : `${taskRelativeFolder()}/${relativePath}`;
    files.push({ path: normalized, ...record });
  }
  const response = await chrome.runtime.sendMessage({
    type: "GAZEAWARE_OFFSCREEN_EXPORT_FILES",
    downloadRoot: session.downloadRoot,
    sessionId: session.sessionId,
    participantId: session.participantId,
    taskId: session.taskId,
    files
  });
  if (!response?.ok) throw new Error(response?.error || "Could not export recording files.");
}

async function downloadDataUrl(message) {
  if (!message?.dataUrl || !message?.filename) throw new Error("Download data and filename are required.");
  const id = await chrome.downloads.download({
    url: message.dataUrl,
    filename: message.filename,
    conflictAction: "overwrite",
    saveAs: false
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === "complete") return { id, filename: item.filename };
    if (item?.state === "interrupted") throw new Error(item.error || `Download ${id} was interrupted.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out writing download ${id}.`);
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
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
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
  if (!handle.queryPermission) return true;
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

async function sha256(content) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizePathPart(value) {
  return String(value || "").trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

function compactTimestamp(iso) {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 17);
}

function randomId() {
  return crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
