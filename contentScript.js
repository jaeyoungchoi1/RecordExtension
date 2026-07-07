(function () {
  const GLOBAL_KEY = "__gazeawareRecorderInputGuard";

  const DEFAULT_SETTINGS = {
    enabled: false,
    viewportWidth: 1080,
    viewportHeight: 720,
    scrollStep: 500,
    isRecording: false
  };

  if (window[GLOBAL_KEY]) {
    window[GLOBAL_KEY].readSettings();
    return;
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    enabled: false,
    targetObserver: null
  };

  function readSettings() {
    chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
      state.settings = normalizeSettings(stored);
      if (state.settings.enabled || state.settings.isRecording) {
        enableGuards();
        syncRecordingGuards();
      } else {
        disableGuards();
      }
    });
  }

  function normalizeSettings(raw) {
    return {
      enabled: Boolean(raw.enabled),
      viewportWidth: toPositiveInteger(raw.viewportWidth, DEFAULT_SETTINGS.viewportWidth),
      viewportHeight: toPositiveInteger(raw.viewportHeight, DEFAULT_SETTINGS.viewportHeight),
      scrollStep: toPositiveInteger(raw.scrollStep, DEFAULT_SETTINGS.scrollStep),
      isRecording: Boolean(raw.isRecording)
    };
  }

  function toPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function enableGuards() {
    if (state.enabled) {
      return;
    }

    window.addEventListener("wheel", preventDefaultScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", preventDefaultScroll, { capture: true, passive: false });
    window.addEventListener("click", handleClick, { capture: true });
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    document.addEventListener("submit", forceSameTabSubmit, { capture: true });
    state.enabled = true;
  }

  function disableGuards() {
    if (!state.enabled) {
      return;
    }

    window.removeEventListener("wheel", preventDefaultScroll, { capture: true });
    window.removeEventListener("touchmove", preventDefaultScroll, { capture: true });
    window.removeEventListener("click", handleClick, { capture: true });
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
    document.removeEventListener("submit", forceSameTabSubmit, { capture: true });
    if (state.targetObserver) {
      state.targetObserver.disconnect();
      state.targetObserver = null;
    }
    state.enabled = false;
  }

  function preventDefaultScroll(event) {
    if (!state.settings.enabled) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function handleKeyDown(event) {
    if (!state.settings.enabled || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const before = getScrollTop();
    const top = event.key === "ArrowDown" ? state.settings.scrollStep : -state.settings.scrollStep;
    window.scrollBy(0, top);
    const after = getScrollTop();
    const scroll = after - before;

    if (state.settings.isRecording) {
      sendInteraction({
        type: event.key === "ArrowDown" ? "scrollBottom" : "scrollTop",
        scroll
      });
    }
  }

  function handleClick(event) {
    if (!state.settings.isRecording) {
      return;
    }

    const anchor = event.target.closest && event.target.closest("a[href]");
    if (!isNavigatingLink(anchor)) {
      return;
    }

    sendNavigationClick(anchor.href);

    if (anchor.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setTimeout(() => {
        window.location.assign(anchor.href);
      }, 50);
    }
  }

  function forceSameTabSubmit(event) {
    if (!state.settings.isRecording || !event.target || event.target.tagName !== "FORM") {
      return;
    }

    event.target.removeAttribute("target");
  }

  function forceSameTabTargets() {
    for (const element of document.querySelectorAll("a[target], form[target], area[target]")) {
      element.removeAttribute("target");
    }
  }

  function observeTargets() {
    if (state.targetObserver || !document.documentElement) {
      return;
    }

    state.targetObserver = new MutationObserver(() => forceSameTabTargets());
    state.targetObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["target"]
    });
  }

  function syncRecordingGuards() {
    if (state.settings.isRecording) {
      forceSameTabTargets();
      observeTargets();
      return;
    }

    if (state.targetObserver) {
      state.targetObserver.disconnect();
      state.targetObserver = null;
    }
  }

  function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  function isIgnoredHref(href) {
    return /^(javascript:|mailto:|tel:|sms:|#)/i.test(href);
  }

  function isNavigatingLink(anchor) {
    if (!anchor || !anchor.href) {
      return false;
    }

    const rawHref = anchor.getAttribute("href") || "";
    if (isIgnoredHref(rawHref.trim())) {
      return false;
    }

    try {
      const targetUrl = new URL(anchor.href, window.location.href);
      const currentUrl = new URL(window.location.href);
      const sameDocument =
        targetUrl.origin === currentUrl.origin &&
        targetUrl.pathname === currentUrl.pathname &&
        targetUrl.search === currentUrl.search;
      return !sameDocument || targetUrl.hash === "";
    } catch (error) {
      return false;
    }
  }

  function sendInteraction(interaction) {
    chrome.runtime.sendMessage({
      type: "GAZEAWARE_INTERACTION",
      interaction
    }).catch(() => {});
  }

  function sendNavigationClick(href) {
    chrome.runtime.sendMessage({
      type: "GAZEAWARE_NAVIGATION_CLICK",
      href,
      sourceUrl: window.location.href
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "GAZEAWARE_APPLY_SETTINGS") {
      readSettings();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const relevantKeys = ["enabled", "viewportWidth", "viewportHeight", "scrollStep", "isRecording"];
    if (relevantKeys.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      readSettings();
    }
  });

  window[GLOBAL_KEY] = { readSettings };
  readSettings();
})();
