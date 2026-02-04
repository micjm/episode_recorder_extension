
/*
Service worker: stores episode + steps, captures screenshots, requests post state from content script, exports JSON.
This uses IndexedDB for storage to avoid chrome.storage quotas when screenshots are enabled.
*/
const DB_NAME = "episode_recorder_db_v1";
const DB_VERSION = 1;

function nowIso() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("episodes")) {
        db.createObjectStore("episodes", { keyPath: "episode_id" });
      }
      if (!db.objectStoreNames.contains("steps")) {
        const store = db.createObjectStore("steps", { keyPath: "step_key" }); // step_key = `${episode_id}:${step_number}`
        store.createIndex("by_episode", "episode_id", { unique: false });
        store.createIndex("by_episode_step", ["episode_id","step_number"], { unique: true });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetStepsForEpisode(episodeId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("steps", "readonly");
    const idx = tx.objectStore("steps").index("by_episode");
    const req = idx.getAll(episodeId);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a,b) => a.step_number - b.step_number);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getSettings() {
  const s = await idbGet("settings", "recorder_state");
  return s?.value || null;
}

async function setSettings(value) {
  await idbPut("settings", { key: "recorder_state", value });
}

async function clearAll() {
  const st = await getSettings();
  if (st?.episodeId) {
    // delete steps and episode metadata
    const steps = await idbGetStepsForEpisode(st.episodeId);
    for (const s of steps) await idbDelete("steps", s.step_key);
    await idbDelete("episodes", st.episodeId);
  }
  await setSettings({
    isRecording: false,
    episodeId: null,
    startedAt: null,
    stepCount: 0,
    lastMessage: "Cleared.",
    options: { captureScreenshots: true, captureDomState: true }
  });
}

async function init() {
  const st = await getSettings();
  if (!st) {
    await setSettings({
      isRecording: false,
      episodeId: null,
      startedAt: null,
      stepCount: 0,
      lastMessage: "",
      options: { captureScreenshots: true, captureDomState: true }
    });
  }
}
await init();

async function setBadge(isRecording) {
  try {
    await chrome.action.setBadgeText({ text: isRecording ? "REC" : "" });
    if (isRecording) await chrome.action.setBadgeBackgroundColor({ color: "#1f6f3d" });
  } catch {}
}

async function broadcastEnabled(enabled) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    try { await chrome.tabs.sendMessage(t.id, { type: "RECORDER_SET_ENABLED", enabled }); } catch {}
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function captureScreenshotForActiveWindow() {
  const win = await chrome.windows.getLastFocused();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: "png" });
    // strip prefix to match browser-use screenshot base64 string usage
    const b64 = dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : dataUrl;
    return { data_url: dataUrl, b64 };
  } catch (e) {
    return { error: String(e) };
  }
}

function shallowDiff(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a||{}), ...Object.keys(b||{})]);
  for (const k of keys) {
    const va = a?.[k];
    const vb = b?.[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) out[k] = { before: va, after: vb };
  }
  return out;
}

async function requestPostState(tabId, captureDomState) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "RECORDER_CAPTURE_POST", captureDomState });
    return resp?.post || null;
  } catch (e) {
    return { error: String(e) };
  }
}

async function startRecording(options) {
  const episodeId = uuid();
  const createdAt = nowIso();

  const episode = {
    episode_id: episodeId,
    created_at: createdAt,
    browser: { name: "chromium" },
    origin: { type: "extension_mvp", build: "0.1.0" },
    steps: [] // not used in storage; steps are stored separately
  };
  await idbPut("episodes", episode);

  const st = await getSettings();
  const mergedOptions = { ...(st?.options || {}), ...(options || {}) };

  let lastMessage = "Recording started.";
  const activeTab = await getActiveTab();
  if (activeTab?.id) {
    const injected = await ensureContentScript(activeTab.id);
    if (!injected.ok) {
      lastMessage = `Recording started, but could not access the active tab: ${injected.error}`;
    }
  }

  await setSettings({
    isRecording: true,
    episodeId,
    startedAt: Date.now(),
    stepCount: 0,
    lastMessage,
    options: mergedOptions
  });

  await setBadge(true);
  await broadcastEnabled(true);

  return { episodeId, stepCount: 0, lastMessage: "Recording started." };
}

async function stopRecording() {
  const st = await getSettings();
  if (!st?.isRecording) return st || {};
  await setSettings({ ...st, isRecording: false, lastMessage: "Recording stopped." });
  await setBadge(false);
  await broadcastEnabled(false);
  return await getSettings();
}

async function setOptions(options) {
  const st = await getSettings();
  const merged = { ...(st?.options || {}), ...(options || {}) };
  await setSettings({ ...(st||{}), options: merged, lastMessage: "Options updated." });
  return await getSettings();
}

// Core: handle RECORDER_EVENT from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const st = await getSettings();
    if (msg?.type === "RECORDER_GET_STATUS") {
      sendResponse(st || {});
      return;
    }
    if (msg?.type === "RECORDER_START") {
      const resp = await startRecording(msg.options);
      sendResponse(resp);
      return;
    }
    if (msg?.type === "RECORDER_STOP") {
      const resp = await stopRecording();
      sendResponse(resp);
      return;
    }
    if (msg?.type === "RECORDER_CLEAR") {
      await clearAll();
      const resp = await getSettings();
      sendResponse(resp);
      return;
    }
    if (msg?.type === "RECORDER_SET_OPTIONS") {
      const resp = await setOptions(msg.options);
      sendResponse(resp);
      return;
    }
    if (msg?.type === "RECORDER_EXPORT") {
      const st2 = await getSettings();
      if (!st2?.episodeId) {
        sendResponse({ episodeId: null, stepCount: 0, lastMessage: "No episode." });
        return;
      }
      const ep = await idbGet("episodes", st2.episodeId);
      const steps = await idbGetStepsForEpisode(st2.episodeId);
      const episodeOut = {
        episode_id: ep.episode_id,
        created_at: ep.created_at,
        browser: ep.browser,
        origin: ep.origin,
        options: st2.options,
        steps: steps.map(s => s.step),
      };
      sendResponse({ episode: episodeOut, episodeId: st2.episodeId, stepCount: steps.length, lastMessage: "Exported." });
      return;
    }

    // Step event
    if (msg?.type === "RECORDER_EVENT" && msg?.event?.kind === "step") {
      if (!st?.isRecording || !st.episodeId) return;

      const tabId = sender?.tab?.id;
      if (!tabId) return;

      const stepNumber = st.stepCount || 0;
      const stepId = uuid();

      // Pre state is provided by content script; enrich with tab info and screenshot (optional)
      const tab = await chrome.tabs.get(tabId);

      const preFromContent = msg.event.pre || {};
      const pre = {
        // BrowserUse-like summary fields
        dom_state: st.options?.captureDomState ? (preFromContent.dom_state || {}) : { llm_representation: "", selector_map: {}, elements_count: 0 },
        url: tab.url || preFromContent.url || "",
        title: tab.title || preFromContent.title || "",
        tabs: [{ url: tab.url || "", title: tab.title || "", tab_id: String(tabId) }],
        page_info: preFromContent.page_info || null,
        frame_url: preFromContent.frame_url,
        is_top_frame: preFromContent.is_top_frame
      };

      if (st.options?.captureScreenshots) {
        const shot = await captureScreenshotForActiveWindow();
        pre.screenshot = shot.b64 || null;
        pre.screenshot_data_url = shot.data_url || null;
        if (shot.error) pre.screenshot_error = shot.error;
      }

      // Action (already structured)
      const action = msg.event.action || { type: "unknown" };

      const stepRecord = {
        step_id: stepId,
        step_number: stepNumber,
        t_ms: msg.event.t_ms ?? null,
        t_iso: msg.event.t_iso ?? null,
        pre,
        action,
        post: null,
        derived: null
      };

      // Persist "pending" step immediately
      await idbPut("steps", {
        step_key: `${st.episodeId}:${stepNumber}`,
        episode_id: st.episodeId,
        step_number: stepNumber,
        step: stepRecord
      });

      // Request post state after a short delay to let the UI settle
      const delayMs = (action.type === "scroll") ? 200 : 500;
      setTimeout(async () => {
        const st3 = await getSettings();
        // It's okay if recording stopped; still finalize the step if episode matches
        if (!st3?.episodeId || st3.episodeId !== st.episodeId) return;

        const postFromContent = await requestPostState(tabId, !!st3.options?.captureDomState);
        const tab2 = await chrome.tabs.get(tabId);

        const post = {
          dom_state: st3.options?.captureDomState ? (postFromContent?.dom_state || {}) : { llm_representation: "", selector_map: {}, elements_count: 0 },
          url: tab2.url || postFromContent?.url || "",
          title: tab2.title || postFromContent?.title || "",
          tabs: [{ url: tab2.url || "", title: tab2.title || "", tab_id: String(tabId) }],
          page_info: postFromContent?.page_info || null,
          frame_url: postFromContent?.frame_url,
          is_top_frame: postFromContent?.is_top_frame
        };

        if (st3.options?.captureScreenshots) {
          const shot2 = await captureScreenshotForActiveWindow();
          post.screenshot = shot2.b64 || null;
          post.screenshot_data_url = shot2.data_url || null;
          if (shot2.error) post.screenshot_error = shot2.error;
        }

        const derived = {
          page_diff: {
            url: (pre.url !== post.url) ? { before: pre.url, after: post.url } : undefined,
            title: (pre.title !== post.title) ? { before: pre.title, after: post.title } : undefined,
            scroll_y: (pre.page_info?.scroll_y !== post.page_info?.scroll_y) ? { before: pre.page_info?.scroll_y, after: post.page_info?.scroll_y } : undefined,
          }
        };

        // Update the step
        const row = await idbGet("steps", `${st.episodeId}:${stepNumber}`);
        if (!row) return;
        row.step.post = post;
        row.step.derived = derived;
        await idbPut("steps", row);

      }, delayMs);

      // Increment step count
      await setSettings({ ...st, stepCount: stepNumber + 1, lastMessage: `Recorded step ${stepNumber}.` });
      sendResponse({ ok: true, stepNumber });
      return;
    }
  })().then(() => {
    // keep channel open? no-op
  }).catch((e) => {
    try { sendResponse({ ok: false, error: String(e) }); } catch {}
  });
  return true; // indicate async response
});

// If a navigation happens, optionally add a navigate step (MVP: just update lastMessage)
// You can extend this to create explicit "navigate" ActionEvent.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  const st = await getSettings();
  if (!st?.isRecording) return;
  // Only top frame navigations
  if (details.frameId !== 0) return;
  await setSettings({ ...st, lastMessage: `Navigation: ${details.url}` });
});
