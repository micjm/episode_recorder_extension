
const $ = (id) => document.getElementById(id);

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (error) {
    return { error: String(error), lastMessage: String(error) };
  }
}

function setStatus(isRecording) {
  const pill = $("statusPill");
  pill.textContent = isRecording ? "ON" : "OFF";
  pill.className = isRecording ? "pill pill-on" : "pill pill-off";
  $("btnStart").disabled = isRecording;
  $("btnStop").disabled = !isRecording;
  $("btnExport").disabled = isRecording; // export only when stopped (simpler)
}

function setMeta({episodeId, stepCount, lastMessage}) {
  $("episodeId").textContent = episodeId || "—";
  $("stepCount").textContent = String(stepCount ?? 0);
  $("lastMessage").textContent = lastMessage || "";
}

async function refresh() {
  const st = await send({type: "RECORDER_GET_STATUS"});
  setStatus(!!st.isRecording);
  setMeta({
    episodeId: st.episodeId,
    stepCount: st.stepCount,
    lastMessage: st.lastMessage
  });

  // Load current options
  $("optScreenshots").checked = !!st.options?.captureScreenshots;
  $("optDomState").checked = !!st.options?.captureDomState;
}

$("btnStart").addEventListener("click", async () => {
  const options = {
    captureScreenshots: $("optScreenshots").checked,
    captureDomState: $("optDomState").checked
  };
  const resp = await send({type: "RECORDER_START", options});
  setMeta(resp || {});
  if (resp?.error) {
    setStatus(false);
    return;
  }
  setStatus(true);
});

$("btnStop").addEventListener("click", async () => {
  const resp = await send({type: "RECORDER_STOP"});
  setMeta(resp || {});
  setStatus(false);
});

$("btnClear").addEventListener("click", async () => {
  const resp = await send({type: "RECORDER_CLEAR"});
  setMeta(resp || {});
  setStatus(!!resp?.isRecording);
});

$("btnExport").addEventListener("click", async () => {
  const resp = await send({type: "RECORDER_EXPORT"});
  if (!resp || !resp.episode) {
    setMeta({episodeId: resp?.episodeId, stepCount: resp?.stepCount, lastMessage: "Nothing to export."});
    return;
  }

  const episode = resp.episode;
  const blob = new Blob([JSON.stringify(episode, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `episode_${episode.episode_id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setMeta({episodeId: episode.episode_id, stepCount: episode.steps?.length ?? 0, lastMessage: "Exported JSON."});
});

$("optScreenshots").addEventListener("change", async () => {
  const resp = await send({type: "RECORDER_SET_OPTIONS", options: {
    captureScreenshots: $("optScreenshots").checked,
    captureDomState: $("optDomState").checked
  }});
  if (resp?.error) {
    setMeta(resp);
    return;
  }
  refresh();
});

$("optDomState").addEventListener("change", async () => {
  const resp = await send({type: "RECORDER_SET_OPTIONS", options: {
    captureScreenshots: $("optScreenshots").checked,
    captureDomState: $("optDomState").checked
  }});
  if (resp?.error) {
    setMeta(resp);
    return;
  }
  refresh();
});

refresh();
