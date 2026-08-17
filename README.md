# GazeAware Record Extension

Chrome Manifest V3 recorder for controlled real-world and synthetic web tasks. It preserves the browser viewport video, interaction stream, and inspectable DOM/accessibility state without pre-assigning gaze or interaction patterns.

## What it records

- adaptive Chrome content viewport: detect and record the active tab size without reapplying a CDP size override; manual mode applies a fixed override once
- wheel/touch scroll blocking and fixed-step `ArrowUp`/`ArrowDown` scroll (200 px by default)
- Start–Stop browser-tab video (`screen.webm`)
- pointer, click, input, change, submit, key, focus, scroll, tab, and navigation events
- action coordinates plus selector, role/name/state, bounds, DOM backend node ID, and AX node IDs when resolvable
- stable-state checkpoints after navigation, SPA route changes, scroll, form/filter changes, modal/card actions, and session boundaries
- per checkpoint: URL/title, PNG, serialized HTML, CDP DOM snapshot, Chrome full AX tree, CSS snapshot/reference, viewport, scroll, and focused element
- task/session metadata, outcome, synthetic dataset/seed/DB references, and QA result

The recorder stores raw evidence. It does not render gaze markers or classify patterns.

## Output

```text
task_logs/
  User <id>/
    completed_tasks.txt
    <task_id>/
      session.json
      events.jsonl
      screen.webm
      qa.json
      states/
        state_0001.json
        state_0001.png
      assets/
        css/<sha256>.css
        dom/<sha256>.html
        dom_snapshot/<sha256>.json
        ax/<sha256>.json
```

`completed_tasks.txt` is updated only after Stop when internal QA passes. A failed or interrupted recording remains inspectable but is not marked completed.

## Install

1. Open `chrome://extensions` in Google Chrome.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this folder.
4. Open the extension's **Log Folder** settings and grant a writable local directory. Brave builds that do not expose the File System Access picker on extension pages automatically export one transferable ZIP under `Downloads/GazeAwareRecorder/exports`.
5. Reload the extension after source changes and refresh the task page.

The `debugger`, `tabCapture`, and `offscreen` permissions are required for fixed viewport capture, CDP snapshots, and continuous video.

## Record a task

1. Open the real or synthetic task page in the active tab.
2. In the popup, enter the participant ID and select Task 01–30. The dropdown is synchronized with `/Users/jaywoong/Documents/cui/task-launcher-netlify/app.js`; site, title, prompt, and start URL are filled automatically.
3. Confirm the detected viewport. **Current tab** is the default; manual width/height remains under **Advanced settings**.
4. Press **Start**. Chrome may show that the tab is being captured/debugged.
5. Perform the task. Use only Arrow Up/Down for scrolling.
6. Reopen the popup, select whether the task was completed, enter the final answer/selection and optional reason, then press **Save result & Finish**.
7. Confirm that the popup reports `completed`; otherwise inspect `qa.json`.

The participant-facing task identity is the numbered launcher position (`01`–`30`). Older source labels such as `TM-C02` are not shown or stored as recorder task IDs.

## Smoke test

Serve the bundled test site:

```bash
python3 -m http.server 8765 --directory test-site
```

Open `http://127.0.0.1:8765/` and record this sequence:

1. toggle **Available only** and select a distance radio
2. type a query and submit it
3. open the SPA results state
4. open and close the details modal
5. select candidate A
6. use ArrowDown and ArrowUp
7. open the full-navigation page and use browser Back
8. Stop with an outcome

Validate the resulting task folder:

```bash
python3 tools/validate_recording.py "/path/to/task_logs/User 1/smoke" --contract-smoke
```

The validator checks manifest/event counts, event ordering, checkpoint references, asset hashes, PNG signatures, video size/duration when `ffprobe` is available, and the expected smoke-test actions.

## Known boundaries

- Cross-origin CSS rules that the page CSSOM does not expose are recorded as unavailable comments. The screenshot, HTML, DOM snapshot, and AX tree remain available.
- Browser chrome outside the web content is not in `screen.webm`; URL/tab/navigation changes are recorded separately.
- Password and sensitive autocomplete fields are redacted.
- Synthetic DB snapshots are external app artifacts; the recorder stores their IDs and app/dataset versions.
