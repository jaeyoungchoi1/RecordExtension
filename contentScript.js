(function () {
  const GLOBAL_KEY = "__gazeawareRecorderInputGuard";

  const DEFAULT_SETTINGS = {
    enabled: false,
    viewportWidth: 1080,
    viewportHeight: 720,
    scrollStep: 120
  };

  if (window[GLOBAL_KEY]) {
    window[GLOBAL_KEY].readSettings();
    return;
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    enabled: false
  };

  function readSettings() {
    chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
      state.settings = normalizeSettings(stored);
      if (state.settings.enabled) {
        enableGuards();
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
      scrollStep: toPositiveInteger(raw.scrollStep, DEFAULT_SETTINGS.scrollStep)
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
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    state.enabled = true;
  }

  function disableGuards() {
    if (!state.enabled) {
      return;
    }

    window.removeEventListener("wheel", preventDefaultScroll, { capture: true });
    window.removeEventListener("touchmove", preventDefaultScroll, { capture: true });
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
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

    const top = event.key === "ArrowDown" ? state.settings.scrollStep : -state.settings.scrollStep;
    window.scrollBy({ top, left: 0, behavior: "instant" });
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

    const relevantKeys = ["enabled", "viewportWidth", "viewportHeight", "scrollStep"];
    if (relevantKeys.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      readSettings();
    }
  });

  window[GLOBAL_KEY] = { readSettings };
  readSettings();
})();
