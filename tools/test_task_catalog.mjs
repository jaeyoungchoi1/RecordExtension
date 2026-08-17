import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const launcherPath = "/Users/jaywoong/Documents/cui/task-launcher-netlify/app.js";
const launcherSource = await readFile(launcherPath, "utf8");
const arrayMatch = launcherSource.match(/const TASKS = (\[[\s\S]*?\n\])\.map\(/);
assert.ok(arrayMatch, `Could not parse TASKS from ${launcherPath}`);

const launcherRows = vm.runInNewContext(arrayMatch[1]);
const context = vm.createContext({ globalThis: {} });
const catalogSource = await readFile(new URL("../taskCatalog.js", import.meta.url), "utf8");
vm.runInContext(catalogSource, context, { filename: "taskCatalog.js" });
const recorderTasks = context.globalThis.GAZEAWARE_TASKS;

assert.equal(recorderTasks.length, launcherRows.length);
for (let index = 0; index < launcherRows.length; index += 1) {
  const row = launcherRows[index];
  const task = recorderTasks[index];
  assert.equal(task.taskId, String(index + 1).padStart(2, "0"));
  assert.equal(task.taskNumber, index + 1);
  assert.equal(task.site, row[3]);
  assert.equal(task.title, row[4]);
  assert.equal(task.prompt, row[5]);
  assert.equal(task.url, row[9]);
  assert.equal("catalogId" in task, false);
}

console.log(`PASS: ${recorderTasks.length} numbered recorder tasks match task-launcher-netlify`);
