import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const listeners = () => ({ addListener() {} });
const chrome = {
  runtime: {
    onMessage: listeners(),
    getManifest: () => ({ version: "test" }),
    getURL: (value) => `chrome-extension://test/${value}`,
  },
  storage: {
    local: {
      get: async (defaults) => defaults,
      set: async () => {},
    },
  },
  tabs: {
    onCreated: listeners(),
    onUpdated: listeners(),
    onActivated: listeners(),
    onRemoved: listeners(),
  },
  webNavigation: { onCommitted: listeners() },
  debugger: { onDetach: listeners() },
};

const context = vm.createContext({
  chrome,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  URL,
  console,
  setTimeout,
  clearTimeout,
  indexedDB: {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({ objectStore: () => ({ get: () => ({}) }) }),
          close() {},
        };
        request.onsuccess?.();
      });
      return request;
    },
  },
});

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
vm.runInContext(source, context, { filename: "background.js" });

const setup = context.normalizeSetup({
  enabled: true,
  userId: "User 7",
  taskId: "smoke / test",
  taskNumber: "7",
  taskSite: "Example",
  taskTitle: "Example task",
  taskUrl: "https://example.com/",
  taskCatalogVersion: "catalog-test",
  viewportMode: "adaptive",
  viewportWidth: "1080",
  viewportHeight: "720",
  scrollStep: "200",
  environmentType: "synthetic",
  taskPrompt: "Choose one candidate",
  datasetSeed: "42",
});
assert.equal(setup.userId, "User_7");
assert.equal(setup.taskId, "smoke___test");
assert.equal(setup.environmentType, "synthetic");
assert.equal(setup.synthetic.seed, "42");
assert.equal(setup.viewportWidth, 1080);
assert.equal(setup.viewportMode, "adaptive");
assert.equal(setup.scrollStep, 200);
assert.equal(setup.taskNumber, 7);
assert.equal(setup.taskTitle, "Example task");

const outcome = context.normalizeOutcome({ status: "success", finalChoice: "candidate-a", dbEndSnapshotId: "db-2" });
assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
  status: "success",
  final_choice: "candidate-a",
  db_end_snapshot_id: "db-2",
  notes: null,
});

const baseSession = {
  startedAt: "2026-08-15T00:00:00.000Z",
  endedAt: "2026-08-15T00:00:10.000Z",
  eventCount: 10,
  stateCount: 3,
  writeFailures: [],
  video: { bytes: 1000, valid: true, duration_ms: 10000 },
};
assert.equal(context.buildQa(baseSession).passed, true);
assert.equal(context.buildQa({ ...baseSession, stateCount: 1 }).passed, false);
assert.equal(context.buildQa({ ...baseSession, writeFailures: [{ stage: "write" }] }).passed, false);
assert.equal(context.buildQa({ ...baseSession, video: { bytes: 1000, valid: false } }).passed, false);

assert.equal(await context.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(context.isWebUrl("https://example.com"), true);
assert.equal(context.isWebUrl("file:///tmp/test.html"), false);

console.log("PASS: recorder core helpers");
