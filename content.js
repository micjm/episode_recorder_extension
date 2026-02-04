
/*
Content script: captures human events and emits a Browser-Use-like "state summary" with:
- dom_state: a short list of visible interactables as "[1]Label" lines + selector_map
- url/title/frame_url
- page_info: viewport + scroll + page dimensions
No screenshots here (background captures screenshots).
*/

let __recorderEnabled = false;
let __lastSentAt = 0;

function nowMs() { return Math.floor(performance.now()); }
function nowIso() { return new Date().toISOString(); }

function cssEscape(s) {
  try { return CSS.escape(s); } catch { return String(s).replace(/["\\]/g, "\\$&"); }
}

function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  const style = window.getComputedStyle(el);
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  // allow off-screen, but not wildly
  return true;
}

function bbox(el) {
  try {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  } catch {
    return null;
  }
}

function getLabelFromLabelFor(el) {
  const id = el.getAttribute && el.getAttribute("id");
  if (!id) return null;
  const lab = document.querySelector(`label[for="${cssEscape(id)}"]`);
  const t = lab ? (lab.innerText || lab.textContent || "").trim() : "";
  return t || null;
}

function getLabelFromAriaLabelledBy(el) {
  const ids = (el.getAttribute && el.getAttribute("aria-labelledby")) || "";
  if (!ids) return null;
  const parts = ids.split(/\s+/).map(x => x.trim()).filter(Boolean);
  const texts = parts.map(pid => {
    const node = document.getElementById(pid);
    return node ? (node.innerText || node.textContent || "").trim() : "";
  }).filter(Boolean);
  return texts.join(" ").trim() || null;
}

function accessibleName(el) {
  if (!el || el.nodeType !== 1) return "";
  const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
  if (aria.trim()) return aria.trim();

  const labelled = getLabelFromAriaLabelledBy(el);
  if (labelled) return labelled;

  const labFor = getLabelFromLabelFor(el);
  if (labFor) return labFor;

  // alt/title
  const alt = (el.getAttribute && el.getAttribute("alt")) || "";
  if (alt.trim()) return alt.trim();
  const title = (el.getAttribute && el.getAttribute("title")) || "";
  if (title.trim()) return title.trim();

  // value/placeholder/text
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const ph = (el.getAttribute && el.getAttribute("placeholder")) || "";
    if (ph.trim()) return ph.trim();
    const val = (el.value || "").trim();
    if (val && val.length <= 80) return val;
  }

  const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  if (txt) return txt.slice(0, 120);

  return tag;
}

function uniqueCssSelector(el) {
  // Best-effort unique-ish selector, limited depth.
  if (!el || el.nodeType !== 1) return null;
  if (el.id) return `#${cssEscape(el.id)}`;

  const parts = [];
  let cur = el;
  for (let depth = 0; cur && cur.nodeType === 1 && depth < 7; depth++) {
    let part = cur.tagName.toLowerCase();

    const role = cur.getAttribute && cur.getAttribute("role");
    if (role) part += `[role="${cssEscape(role)}"]`;

    const name = cur.getAttribute && cur.getAttribute("name");
    if (name) part += `[name="${cssEscape(name)}"]`;

    const aria = cur.getAttribute && cur.getAttribute("aria-label");
    if (aria) part += `[aria-label="${cssEscape(aria.slice(0, 60))}"]`;

    const cls = (cur.getAttribute && cur.getAttribute("class") || "").trim()
      .split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += "." + cls.map(cssEscape).join(".");

    if (cur.parentElement) {
      const siblings = Array.from(cur.parentElement.children).filter(x => x.tagName === cur.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }

    parts.unshift(part);
    const sel = parts.join(" > ");
    try {
      if (document.querySelectorAll(sel).length === 1) return sel;
    } catch {}
    cur = cur.parentElement;
  }

  return parts.join(" > ");
}

function xpathSelector(el) {
  if (!el || el.nodeType !== 1) return null;
  // XPath that uses ids when present; otherwise positional.
  const segments = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && segments.length < 8) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id) {
      segments.unshift(`//*[@id="${cur.id}"]`);
      return segments.join("");
    } else {
      let index = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) index++;
        sib = sib.previousElementSibling;
      }
      segments.unshift(`/${tag}[${index}]`);
      cur = cur.parentElement;
    }
  }
  return segments.length ? segments.join("") : null;
}

function nearbyText(el) {
  const out = [];
  const push = (node) => {
    if (!node) return;
    const t = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
    if (t) out.push(t.slice(0, 200));
  };
  push(el);
  push(el && el.parentElement);
  push(el && el.previousElementSibling);
  push(el && el.nextElementSibling);
  return Array.from(new Set(out)).slice(0, 5);
}

function safeAttrs(el) {
  const attrs = {};
  if (!el || el.nodeType !== 1 || !el.getAttribute) return attrs;
  const keys = ["id","name","type","role","aria-label","aria-labelledby","aria-describedby","placeholder","href","value","data-testid"];
  for (const k of keys) {
    const v = el.getAttribute(k);
    if (v && v.length <= 200) attrs[k] = v;
  }
  return attrs;
}

function elementRef(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute && el.getAttribute("role")) || undefined;
  const name = accessibleName(el) || undefined;

  const ref = {
    dom: {
      tag,
      attrs: safeAttrs(el),
      selectors: {
        css: uniqueCssSelector(el),
        xpath: xpathSelector(el)
      },
      nearby_text: nearbyText(el),
      name,
      role
    },
    layout: {
      bbox: bbox(el),
      viewport: { w: window.innerWidth, h: window.innerHeight, scroll_x: window.scrollX, scroll_y: window.scrollY, dpr: window.devicePixelRatio }
    },
    context: {
      frame_url: location.href,
      is_top_frame: (window.top === window),
    }
  };
  return ref;
}

function pageInfo() {
  const doc = document.documentElement;
  const body = document.body;
  const pageW = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth);
  const pageH = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const pixelsAbove = sy;
  const pixelsBelow = Math.max(0, pageH - (sy + vh));
  const pixelsLeft = sx;
  const pixelsRight = Math.max(0, pageW - (sx + vw));
  return {
    viewport_width: vw,
    viewport_height: vh,
    page_width: pageW,
    page_height: pageH,
    scroll_x: sx,
    scroll_y: sy,
    pixels_above: pixelsAbove,
    pixels_below: pixelsBelow,
    pixels_left: pixelsLeft,
    pixels_right: pixelsRight
  };
}

function listInteractables(limit = 60) {
  const candidates = Array.from(document.querySelectorAll([
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[contenteditable='true']"
  ].join(",")));

  const items = [];
  for (const el of candidates) {
    if (!isVisible(el)) continue;

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute && el.getAttribute("type");
    const role = el.getAttribute && el.getAttribute("role");
    const name = accessibleName(el);

    // Skip purely decorative empty things
    if (!name || !name.trim()) continue;

    const disabled = !!(el.disabled || el.getAttribute?.("aria-disabled") === "true");
    const r = el.getBoundingClientRect();
    const inViewport = r.bottom >= 0 && r.right >= 0 && r.top <= window.innerHeight && r.left <= window.innerWidth;

    // Prefer visible in viewport; still allow some off-viewport but deprioritize by pushing later.
    items.push({
      tag, type: type || undefined, role: role || undefined,
      label: name.trim().slice(0, 140),
      disabled,
      bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
      selectors: { css: uniqueCssSelector(el), xpath: xpathSelector(el) },
      attrs: safeAttrs(el),
      in_viewport: inViewport
    });

    if (items.length >= limit * 2) break;
  }

  // Sort: in-viewport first, then by position top->bottom, left->right
  items.sort((a,b) => {
    if (a.in_viewport !== b.in_viewport) return a.in_viewport ? -1 : 1;
    return (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x);
  });

  const trimmed = items.slice(0, limit);
  const selector_map = {};
  const lines = [];
  trimmed.forEach((it, idx) => {
    const n = idx + 1;
    selector_map[String(n)] = it;
    lines.push(`[${n}] ${it.label}`);
  });

  return {
    llm_representation: lines.join("\n"),
    selector_map,
    elements_count: trimmed.length
  };
}

function isSensitiveInput(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
  if (["password"].includes(type)) return true;
  const name = (el.getAttribute && el.getAttribute("name") || "").toLowerCase();
  const ac = (el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase();
  if (name.includes("password") || name.includes("passcode")) return true;
  if (ac.includes("cc-") || ac.includes("credit") || ac.includes("card")) return true;
  return false;
}

function buildStateSummary({targetEl=null, captureDomState=true} = {}) {
  const dom_state = captureDomState ? listInteractables(60) : { llm_representation: "", selector_map: {}, elements_count: 0 };
  if (targetEl) {
    dom_state.interacted_element = elementRef(targetEl);
  }
  return {
    dom_state,
    url: (window.top === window) ? location.href : undefined,
    title: (window.top === window) ? document.title : undefined,
    frame_url: location.href,
    is_top_frame: (window.top === window),
    page_info: pageInfo()
  };
}

async function sendEvent(payload) {
  if (!__recorderEnabled) return;
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (e) {
    // Ignore if extension context unavailable
  }
}

function shouldThrottle(ms=80) {
  const now = performance.now();
  if (now - __lastSentAt < ms) return true;
  __lastSentAt = now;
  return false;
}

function resolveTargetFromEvent(e) {
  // Use composedPath for shadow DOM
  const path = e.composedPath ? e.composedPath() : [];
  for (const node of path) {
    if (node && node.nodeType === 1) return node;
  }
  return e.target && e.target.nodeType === 1 ? e.target : null;
}

function pointerInfo(e) {
  return {
    x: e.clientX,
    y: e.clientY,
    button: e.button,
    modifiers: [
      e.altKey ? "Alt" : null,
      e.ctrlKey ? "Ctrl" : null,
      e.metaKey ? "Meta" : null,
      e.shiftKey ? "Shift" : null,
    ].filter(Boolean)
  };
}

function keyInfo(e) {
  return {
    key: e.key,
    code: e.code,
    modifiers: [
      e.altKey ? "Alt" : null,
      e.ctrlKey ? "Ctrl" : null,
      e.metaKey ? "Meta" : null,
      e.shiftKey ? "Shift" : null,
    ].filter(Boolean)
  };
}

function shouldRecordKey(e) {
  // Only high-signal keys for MVP
  return ["Enter","Escape","Tab"].includes(e.key);
}

// Event listeners
function onPointerDown(e) {
  if (!__recorderEnabled) return;
  if (e.button !== 0) return;
  const target = resolveTargetFromEvent(e);
  if (!target) return;

  const captureDomState = true;
  const pre = buildStateSummary({targetEl: target, captureDomState});
  const act = {
    type: "click",
    pointer: pointerInfo(e),
    target_ref: elementRef(target)
  };

  sendEvent({
    type: "RECORDER_EVENT",
    event: {
      kind: "step",
      action: act,
      pre,
      // post is captured later (background requests)
      t_ms: nowMs(),
      t_iso: nowIso()
    }
  });
}

let __scrollTimer = null;
let __lastScrollY = window.scrollY;

function onScroll(e) {
  if (!__recorderEnabled) return;
  if (__scrollTimer) clearTimeout(__scrollTimer);
  __scrollTimer = setTimeout(() => {
    const dy = window.scrollY - __lastScrollY;
    __lastScrollY = window.scrollY;

    const pre = buildStateSummary({targetEl: null, captureDomState: false});
    const act = { type: "scroll", dx: 0, dy };
    sendEvent({
      type: "RECORDER_EVENT",
      event: {
        kind: "step",
        action: act,
        pre,
        t_ms: nowMs(),
        t_iso: nowIso()
      }
    });
  }, 250);
}

let __focusPre = null;
let __focusEl = null;

function onFocusIn(e) {
  if (!__recorderEnabled) return;
  const target = resolveTargetFromEvent(e);
  if (!target) return;

  const tag = target.tagName.toLowerCase();
  if (!["input","textarea","select"].includes(tag) && !target.isContentEditable) return;

  __focusEl = target;
  __focusPre = buildStateSummary({targetEl: target, captureDomState: true});
}

function onChange(e) {
  if (!__recorderEnabled) return;
  const target = resolveTargetFromEvent(e);
  if (!target) return;

  const tag = target.tagName.toLowerCase();
  const isSelect = tag === "select";
  const isTextInput = tag === "input" || tag === "textarea" || target.isContentEditable;

  if (!isSelect && !isTextInput) return;

  const pre = (__focusEl === target && __focusPre) ? __focusPre : buildStateSummary({targetEl: target, captureDomState: true});

  let value = null;
  if (isSelect) {
    const opt = target.options && target.selectedIndex >= 0 ? target.options[target.selectedIndex] : null;
    value = opt ? (opt.value || opt.textContent || "").trim() : null;
  } else {
    if (isSensitiveInput(target)) value = "<redacted>";
    else if (target.isContentEditable) value = (target.innerText || "").trim().slice(0, 2000);
    else value = (target.value || "").toString().slice(0, 2000);
  }

  const act = isSelect
    ? { type: "select", target_ref: elementRef(target), option_value: value }
    : { type: "input", target_ref: elementRef(target), value };

  __focusEl = null;
  __focusPre = null;

  sendEvent({
    type: "RECORDER_EVENT",
    event: {
      kind: "step",
      action: act,
      pre,
      t_ms: nowMs(),
      t_iso: nowIso()
    }
  });
}

function onKeyDown(e) {
  if (!__recorderEnabled) return;
  if (!shouldRecordKey(e)) return;
  const target = resolveTargetFromEvent(e);
  const pre = buildStateSummary({targetEl: target, captureDomState: false});
  const act = { type: "key", keys: [e.key], target_ref: target ? elementRef(target) : null, key_info: keyInfo(e) };
  sendEvent({
    type: "RECORDER_EVENT",
    event: {
      kind: "step",
      action: act,
      pre,
      t_ms: nowMs(),
      t_iso: nowIso()
    }
  });
}

// Post-capture request from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "RECORDER_SET_ENABLED") {
    __recorderEnabled = !!msg.enabled;
    sendResponse({ok: true, enabled: __recorderEnabled});
    return true;
  }
  if (msg.type === "RECORDER_CAPTURE_POST") {
    const captureDomState = !!msg.captureDomState;
    const st = buildStateSummary({targetEl: null, captureDomState});
    sendResponse({ok: true, post: st});
    return true;
  }
});

// Attach listeners once
(function attach() {
  document.addEventListener("pointerdown", onPointerDown, {capture: true, passive: true});
  window.addEventListener("scroll", onScroll, {capture: true, passive: true});
  document.addEventListener("focusin", onFocusIn, {capture: true, passive: true});
  document.addEventListener("change", onChange, {capture: true, passive: true});
  document.addEventListener("keydown", onKeyDown, {capture: true, passive: true});
})();
