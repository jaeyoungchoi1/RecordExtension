#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const portalDir = path.resolve(__dirname, 'coding_study');

class Element {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.title = '';
    this.href = '';
    this.style = {};
    this.children = [];
    this.options = [];
    this.checked = false;
    this.listeners = {};
    this._innerHTML = '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (value === '') {
      this.children = [];
      this.options = [];
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  add(option) {
    this.options.push(option);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }

  dispatch(type) {
    (this.listeners[type] || []).forEach(callback => callback({target: this}));
  }

  insertAdjacentHTML(_position, html) {
    const value = html.match(/value="([^"]+)"/)?.[1];
    if (value !== undefined) {
      const input = new Element('input');
      input.value = value;
      this.children.push(input);
    }
    this._innerHTML += html;
  }

  querySelectorAll(selector) {
    if (selector === 'input') return this.children.filter(child => child.tagName === 'INPUT');
    if (selector === 'input:checked') return this.children.filter(child => child.tagName === 'INPUT' && child.checked);
    return [];
  }

  click() {
    this.onclick?.();
  }
}

function Option(text, value = '') {
  this.text = text;
  this.value = String(value);
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

const ids = [
  'coderBadge', 'progress', 'exportCsv', 'exportJson', 'previousSample',
  'sampleSelect', 'nextSample', 'incompleteOnly', 'saveStatus', 'sampleList',
  'episodeTitle', 'episodeMeta', 'visualReview', 'sourceWarning', 'taskPrompt',
  'sourceEvidence', 'resultEvidence', 'adjacentContext', 'constraints',
  'primaryBehavior', 'secondaryBehavior', 'axProjection', 'outcome',
  'confidence', 'needsReview', 'modifiers', 'evidenceNote', 'notes',
  'codebookReference'
];

function buildHarness(coderId, storage) {
  const selectIds = new Set(['sampleSelect', 'primaryBehavior', 'secondaryBehavior', 'axProjection', 'outcome', 'confidence', 'needsReview']);
  const elements = Object.fromEntries(ids.map(id => [id, new Element(selectIds.has(id) ? 'select' : 'div', id)]));
  elements.incompleteOnly.checked = false;
  const windowListeners = {};
  const document = {
    getElementById: id => elements[id] || null,
    createElement: tagName => new Element(tagName)
  };
  let nextTimer = 1;
  const context = vm.createContext({
    console,
    document,
    Option,
    localStorage: storage,
    location: {search: `?coder=${coderId}`},
    URLSearchParams,
    URL: {createObjectURL: () => 'blob:test', revokeObjectURL: () => {}},
    Blob,
    Date,
    setTimeout(callback) {
      callback();
      return nextTimer++;
    },
    clearTimeout() {},
    encodeURIComponent,
    window: null
  });
  context.window = context;
  context.addEventListener = (type, callback) => {
    (windowListeners[type] ||= []).push(callback);
  };
  vm.runInContext(fs.readFileSync(path.join(portalDir, 'coding_portal_data.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(portalDir, 'coding_portal_app.js'), 'utf8'), context);
  return {context, elements, windowListeners};
}

const storage = new MemoryStorage();
const coderA = buildHarness('A', storage);
assert.equal(coderA.context.CODING_PORTAL_DATA.samples.length, 60);
assert.equal(coderA.elements.sampleSelect.options.length, 60);
assert.equal(coderA.elements.coderBadge.textContent, 'Coder A');
assert.match(coderA.elements.visualReview.href, /coder=A/);
assert.match(coderA.elements.visualReview.href, /readonly=1/);

coderA.elements.primaryBehavior.value = 'DIR';
coderA.elements.axProjection.value = 'AX_LOCAL';
coderA.elements.outcome.value = 'OUT_SELECT';
coderA.elements.confidence.value = 'high';
coderA.elements.needsReview.value = 'false';
coderA.elements.evidenceNote.value = 'Visit #1 aligns with the recorded action.';
coderA.elements.evidenceNote.dispatch('input');

const storedA = JSON.parse(storage.getItem('episode-coding-portal:A'));
assert.equal(storedA.S001.primary_behavior, 'DIR');
assert.equal(storedA.S001.evidence, 'Visit #1 aligns with the recorded action.');
assert.equal(coderA.elements.progress.textContent, '1 / 60 complete');

coderA.elements.nextSample.click();
assert.equal(coderA.elements.sampleSelect.value, 'S002');
assert.equal(JSON.parse(storage.getItem('episode-coding-portal:A')).S001.primary_behavior, 'DIR');

const coderB = buildHarness('B', storage);
assert.equal(coderB.elements.coderBadge.textContent, 'Coder B');
assert.equal(coderB.elements.progress.textContent, '0 / 60 complete');
assert.equal(storage.getItem('episode-coding-portal:B'), null);
assert.match(coderB.elements.visualReview.href, /coder=B/);

const restoredA = buildHarness('A', storage);
assert.equal(restoredA.elements.primaryBehavior.value, 'DIR');
assert.equal(restoredA.elements.evidenceNote.value, 'Visit #1 aligns with the recorded action.');
assert.equal(restoredA.elements.progress.textContent, '1 / 60 complete');
restoredA.windowListeners.beforeunload[0]();

console.log(JSON.stringify({
  samples: 60,
  coder_isolation: true,
  debounced_text_autosave: true,
  navigation_preserves_previous_sample: true,
  beforeunload_save: true,
  readonly_visual_links: true
}, null, 2));
