# Episode Recorder (DOM + Screenshot) — Chrome Extension (MVP)

## Purpose

This extension records a **human-performed browser workflow** into a structured “Episode” JSON file that can be used for:

- **Demos** of “record → compile → agent replay” browser automation
- Generating training data for a browser agent (e.g., imitation / skill extraction)
- Debugging and evaluation (what changed on the page after each action)

The key idea is to log steps in the same *kind of language* a browser agent uses:
- a compact, query-friendly **DOM state summary** (visible interactables list)
- optional **viewport screenshots**
- a structured **action event**
- a **post-action observation** and a small derived diff

This is an **execution recorder for a human session**, not a browser-driving agent.

---

## What it records

Each recorded Episode is an ordered list of Steps.

Each Step contains:

- **pre**: observation before the action
  - `dom_state.llm_representation`: newline list like:
    ```
    [1] Orders
    [2] Search
    [3] Filter
    ```
  - `dom_state.selector_map`: for each index, includes best-effort selectors, bbox, attrs, label
  - `page_info`: viewport size, scroll position, page dimensions, pixels above/below, etc.
  - `url`, `title`, and minimal tab metadata
  - optional `screenshot` (base64 PNG) and `screenshot_data_url`

- **action**: structured event
  - `click` (with pointer info + target element ref)
  - `input` (with target + value; sensitive fields are redacted)
  - `select` (with target + selected value)
  - `scroll` (dx/dy)
  - `key` (Enter/Escape/Tab in MVP)

- **post**: observation after a short delay (UI settles), same shape as `pre`

- **derived**: minimal diffs (URL/title/scroll changes)

---

## What it does *not* record (MVP)

- Audio narration / transcripts
- Full CDP DOMSnapshot
- Full accessibility tree (AX)
- Network logs / request traces
- “True pre” screenshots for typing (MVP captures input on change; can be improved)

---

## Why this format

Browser agents typically do not consume raw HTML or full screenshots for every step; they consume a **compact page representation** plus tools to query more detail. This MVP simulates that by producing:

- a compact **interactables list** (agent-friendly)
- a structured **element reference** (selectors + attributes + nearby text + bbox)
- a per-step **before/after** observation

This is meant to be easy to:
- compile into skills
- replay or evaluate
- use as training episodes

---

## Install (Developer Mode)

1. Unzip the extension folder.
2. Open Chrome and go to: `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the unzipped folder: `episode_recorder_extension/`

---

## Use

1. Navigate to a normal website (not `chrome://` pages).
2. Click the extension icon to open the popup.
3. Click **Start recording**.
4. Perform the workflow normally.
5. Click **Stop**.
6. Click **Export episode JSON** to download `episode_<id>.json`.

Options in the popup:
- **Capture screenshots**: includes base64 PNG screenshots in each step
- **Capture DOM state**: includes the interactables summary and selector map

---

## Output structure

Export produces a single JSON file:

- `episode_id`
- `created_at`
- `browser`
- `origin`
- `options`
- `steps[]`

Each `steps[i]` has:
- `step_id`, `step_number`
- `pre`, `action`, `post`
- `derived`

Screenshots are embedded as base64 strings under:
- `pre.screenshot`
- `post.screenshot`

---

## Storage and privacy notes

- While recording, data is stored locally in **IndexedDB** within the extension.
- Export downloads a JSON file to your machine.
- By default, values for sensitive inputs (password-like fields) are **redacted**.

You should treat exported episodes as potentially sensitive because they may include:
- page text
- visible UI labels
- screenshots (if enabled)

---

## Known limitations / expected improvements

This is a demo-quality recorder meant to unblock experimentation.

Planned upgrades:
- Switch to an `assets` directory export (screenshots as separate files, JSON references)
- Add **true pre/post** capture for typing (capture on focus/keydown)
- Add **CDP snapshots** (DOMSnapshot + AX tree) via `chrome.debugger` (optional)
- Add domain allow/deny lists and richer redaction policies
- Add richer derived diffs and success signals

---

## Files

- `manifest.json` — MV3 config
- `background.js` — service worker (storage, screenshot capture, export)
- `content.js` — event capture + DOM summarization (visible interactables)
- `popup.html / popup.js / popup.css` — simple start/stop/export UI

---

## Intended next step

Use the exported Episode JSON as input to:
- a compiler that turns episodes into reusable “skills”
- an agent runner that uses DOM selectors + optional vision to execute those skills
- an evaluation harness to measure success/failure and recovery

