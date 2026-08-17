(function () {
  const GLOBAL_KEY = "__gazeawareRecorderV2";
  const DEFAULT_SETTINGS = {
    enabled: true,
    viewportWidth: 1080,
    viewportHeight: 720,
    scrollStep: 200,
    isRecording: false
  };

  if (window[GLOBAL_KEY]) {
    window[GLOBAL_KEY].readSettings();
    return;
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    enabled: false,
    targetObserver: null,
    urlTimer: null,
    mutationTimer: null,
    recentActionAt: 0,
    lastUrl: location.href,
    elementIds: new WeakMap(),
    nextElementId: 1
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
      viewportWidth: positiveInteger(raw.viewportWidth, DEFAULT_SETTINGS.viewportWidth),
      viewportHeight: positiveInteger(raw.viewportHeight, DEFAULT_SETTINGS.viewportHeight),
      scrollStep: positiveInteger(raw.scrollStep, DEFAULT_SETTINGS.scrollStep),
      isRecording: Boolean(raw.isRecording)
    };
  }

  function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function enableGuards() {
    if (state.enabled) return;

    window.addEventListener("wheel", preventDefaultScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", preventDefaultScroll, { capture: true, passive: false });
    window.addEventListener("pointerdown", handlePointer, { capture: true });
    window.addEventListener("pointerup", handlePointer, { capture: true });
    window.addEventListener("click", handleClick, { capture: true });
    window.addEventListener("dblclick", handlePointer, { capture: true });
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("input", handleInput, { capture: true });
    window.addEventListener("change", handleChange, { capture: true });
    window.addEventListener("focusin", handleFocus, { capture: true });
    window.addEventListener("focusout", handleFocus, { capture: true });
    document.addEventListener("submit", handleSubmit, { capture: true });
    window.addEventListener("hashchange", handleRouteEvent, { capture: true });
    window.addEventListener("popstate", handleRouteEvent, { capture: true });
    state.enabled = true;
  }

  function disableGuards() {
    if (!state.enabled) return;

    window.removeEventListener("wheel", preventDefaultScroll, { capture: true });
    window.removeEventListener("touchmove", preventDefaultScroll, { capture: true });
    window.removeEventListener("pointerdown", handlePointer, { capture: true });
    window.removeEventListener("pointerup", handlePointer, { capture: true });
    window.removeEventListener("click", handleClick, { capture: true });
    window.removeEventListener("dblclick", handlePointer, { capture: true });
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
    window.removeEventListener("input", handleInput, { capture: true });
    window.removeEventListener("change", handleChange, { capture: true });
    window.removeEventListener("focusin", handleFocus, { capture: true });
    window.removeEventListener("focusout", handleFocus, { capture: true });
    document.removeEventListener("submit", handleSubmit, { capture: true });
    window.removeEventListener("hashchange", handleRouteEvent, { capture: true });
    window.removeEventListener("popstate", handleRouteEvent, { capture: true });
    stopObservers();
    state.enabled = false;
  }

  function preventDefaultScroll(event) {
    if (!state.settings.enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function handlePointer(event) {
    if (!state.settings.isRecording) return;
    sendInteraction({
      type: event.type,
      pointer: {
        x: event.clientX,
        y: event.clientY,
        screen_x: event.screenX,
        screen_y: event.screenY,
        button: event.button,
        buttons: event.buttons,
        pointer_type: event.pointerType || "mouse"
      },
      target: describeElement(event.target),
      checkpoint: event.type === "dblclick"
    });
  }

  function handleClick(event) {
    if (!state.settings.isRecording) return;

    const target = event.target instanceof Element ? event.target : null;
    const anchor = target && target.closest("a[href]");
    sendInteraction({
      type: "click",
      pointer: {
        x: event.clientX,
        y: event.clientY,
        screen_x: event.screenX,
        screen_y: event.screenY,
        button: event.button,
        buttons: event.buttons
      },
      target: describeElement(target),
      navigation_href: anchor ? anchor.href : null,
      checkpoint: true
    });

    if (anchor && (anchor.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setTimeout(() => window.location.assign(anchor.href), 50);
    }
  }

  function handleKeyDown(event) {
    if (!state.settings.isRecording && !state.settings.enabled) return;

    if (
      state.settings.enabled &&
      !event.repeat &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const before = scrollPosition();
      const amount = event.key === "ArrowDown" ? state.settings.scrollStep : -state.settings.scrollStep;
      window.scrollBy(0, amount);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const after = scrollPosition();
        if (state.settings.isRecording) {
          sendInteraction({
            type: event.key === "ArrowDown" ? "scroll_down" : "scroll_up",
            key: keyboardData(event),
            scroll_before: before,
            scroll_after: after,
            scroll_delta: { x: after.x - before.x, y: after.y - before.y },
            target: describeElement(event.target),
            checkpoint: true
          });
        }
      }));
      return;
    }

    if (!state.settings.isRecording) return;
    sendInteraction({
      type: "keydown",
      key: keyboardData(event),
      target: describeElement(event.target),
      checkpoint: event.key === "Enter" || event.key === "Escape"
    });
  }

  function handleInput(event) {
    if (!state.settings.isRecording) return;
    sendInteraction({
      type: "input",
      input_type: event.inputType || null,
      value: safeValue(event.target),
      target: describeElement(event.target),
      checkpoint: true,
      checkpoint_delay_ms: 700
    });
  }

  function handleChange(event) {
    if (!state.settings.isRecording) return;
    sendInteraction({
      type: "change",
      value: safeValue(event.target),
      target: describeElement(event.target),
      checkpoint: true
    });
  }

  function handleFocus(event) {
    if (!state.settings.isRecording) return;
    sendInteraction({
      type: event.type === "focusin" ? "focus" : "blur",
      target: describeElement(event.target),
      checkpoint: false
    });
  }

  function handleSubmit(event) {
    if (event.target && event.target.tagName === "FORM") {
      event.target.removeAttribute("target");
    }
    if (!state.settings.isRecording) return;
    sendInteraction({
      type: "submit",
      target: describeElement(event.target),
      checkpoint: true,
      checkpoint_delay_ms: 900
    });
  }

  function handleRouteEvent(event) {
    if (!state.settings.isRecording) return;
    const previousUrl = state.lastUrl;
    state.lastUrl = location.href;
    sendInteraction({
      type: event.type,
      previous_url: previousUrl,
      current_url: location.href,
      target: null,
      checkpoint: true,
      checkpoint_delay_ms: 700
    });
  }

  function keyboardData(event) {
    const printable = event.key && event.key.length === 1;
    const sensitive = isSensitiveField(event.target);
    return {
      key: printable && sensitive ? "[REDACTED]" : event.key,
      code: event.code,
      repeat: event.repeat,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey
    };
  }

  function safeValue(target) {
    if (!(target instanceof Element)) return null;
    if (isSensitiveField(target)) return "[REDACTED]";
    if (target instanceof HTMLInputElement) {
      if (target.type === "checkbox" || target.type === "radio") return target.checked;
      return truncate(target.value, 500);
    }
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return truncate(target.value, 500);
    }
    return null;
  }

  function isSensitiveField(target) {
    if (!(target instanceof Element)) return false;
    const type = String(target.getAttribute("type") || "").toLowerCase();
    const autocomplete = String(target.getAttribute("autocomplete") || "").toLowerCase();
    return type === "password" || /password|cc-|credit-card|one-time-code/.test(autocomplete);
  }

  function describeElement(target) {
    if (!(target instanceof Element)) return null;
    const element = target.closest("button,a,input,select,textarea,[role],[tabindex],label,form") || target;
    const rect = element.getBoundingClientRect();
    const id = getElementId(element);
    const role = element.getAttribute("role") || implicitRole(element);
    const name = accessibleName(element);
    const description = {
      recorder_element_id: id,
      selector: buildSelector(element),
      tag: element.tagName,
      id: element.id || null,
      role,
      accessible_name: truncate(name, 500),
      aria_label: element.getAttribute("aria-label"),
      text: truncate(normalizedText(element), 500),
      href: element instanceof HTMLAnchorElement ? element.href : null,
      value: safeValue(element),
      checked: "checked" in element ? Boolean(element.checked) : null,
      selected: element instanceof HTMLOptionElement ? element.selected : null,
      expanded: ariaBoolean(element, "aria-expanded"),
      disabled: "disabled" in element ? Boolean(element.disabled) : ariaBoolean(element, "aria-disabled"),
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left
      }
    };
    return description;
  }

  function getElementId(element) {
    if (!state.elementIds.has(element)) {
      state.elementIds.set(element, `element_${state.nextElementId++}`);
    }
    return state.elementIds.get(element);
  }

  function buildSelector(element) {
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
      let part = current.tagName.toLowerCase();
      const stableAttributes = ["data-testid", "data-test", "name", "aria-label"];
      const stable = stableAttributes.find((name) => current.hasAttribute(name));
      if (stable) {
        part += `[${stable}="${cssEscape(current.getAttribute(stable))}"]`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }

  function accessibleName(element) {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (text) return text;
    }
    if (element instanceof HTMLInputElement && element.labels && element.labels.length) {
      return Array.from(element.labels).map((label) => label.textContent || "").join(" ").trim();
    }
    return element.getAttribute("alt") || element.getAttribute("title") || normalizedText(element);
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    return null;
  }

  function ariaBoolean(element, name) {
    if (!element.hasAttribute(name)) return null;
    return element.getAttribute(name) === "true";
  }

  function normalizedText(element) {
    return String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function truncate(value, length) {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function scrollPosition() {
    return { x: window.scrollX || 0, y: window.scrollY || 0 };
  }

  function eventClock() {
    return {
      timestamp: new Date().toISOString(),
      timestamp_ms: Date.now(),
      performance_ms: performance.now(),
      performance_time_origin_ms: performance.timeOrigin
    };
  }

  function sendInteraction(interaction) {
    if (interaction.checkpoint && interaction.type !== "dom_settled") {
      state.recentActionAt = Date.now();
    }
    chrome.runtime.sendMessage({
      type: "GAZEAWARE_INTERACTION",
      interaction: {
        ...eventClock(),
        ...interaction,
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
        scroll: scrollPosition()
      }
    }).catch(() => {});
  }

  function forceSameTabTargets() {
    for (const element of document.querySelectorAll("a[target], form[target], area[target]")) {
      element.removeAttribute("target");
    }
  }

  function startObservers() {
    if (!state.targetObserver && document.documentElement) {
      state.targetObserver = new MutationObserver(() => {
        forceSameTabTargets();
        if (!state.settings.isRecording || Date.now() - state.recentActionAt > 5000) return;
        if (state.mutationTimer) clearTimeout(state.mutationTimer);
        state.mutationTimer = setTimeout(() => {
          state.mutationTimer = null;
          sendInteraction({ type: "dom_settled", target: null, checkpoint: true, checkpoint_delay_ms: 150 });
        }, 650);
      });
      state.targetObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }
    if (!state.urlTimer) {
      state.lastUrl = location.href;
      state.urlTimer = setInterval(() => {
        if (!state.settings.isRecording || location.href === state.lastUrl) return;
        const previousUrl = state.lastUrl;
        state.lastUrl = location.href;
        sendInteraction({
          type: "spa_route_change",
          previous_url: previousUrl,
          current_url: location.href,
          target: null,
          checkpoint: true,
          checkpoint_delay_ms: 700
        });
      }, 250);
    }
  }

  function stopObservers() {
    if (state.targetObserver) state.targetObserver.disconnect();
    state.targetObserver = null;
    if (state.mutationTimer) clearTimeout(state.mutationTimer);
    state.mutationTimer = null;
    if (state.urlTimer) clearInterval(state.urlTimer);
    state.urlTimer = null;
  }

  function syncRecordingGuards() {
    if (state.settings.isRecording) {
      forceSameTabTargets();
      startObservers();
    } else {
      stopObservers();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && (message.type === "GAZEAWARE_APPLY_SETTINGS" || message.type === "GAZEAWARE_DESCRIBE_STATE")) {
      readSettings();
    }
    if (message && message.type === "GAZEAWARE_DESCRIBE_STATE") {
      sendResponse({
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio },
        scroll: scrollPosition(),
        focused: describeElement(document.activeElement)
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const keys = ["enabled", "viewportWidth", "viewportHeight", "scrollStep", "isRecording"];
    if (keys.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) readSettings();
  });

  window[GLOBAL_KEY] = { readSettings };
  readSettings();
})();
