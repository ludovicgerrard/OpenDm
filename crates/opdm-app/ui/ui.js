/* OpenDM frontend logic (Tauri global API, no bundler) */
const { core, event } = (window.__TAURI__ ?? {});
const invoke = (c, a) => core?.invoke(c, a) ?? Promise.reject("no tauri");

const STATE = { 1: ["Queued", "b-queued"], 2: ["Downloading", "b-running"], 3: ["Paused", "b-paused"], 4: ["Done", "b-done"], 5: ["Error", "b-error"] };

const rows = document.getElementById("rows");
const empty = document.getElementById("empty");
const counters = document.getElementById("counters");
const folderLabel = document.getElementById("folder");

function fmtSize(b) {
  if (!b) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
function fmtSpeed(b) { return !b || b < 1 ? "" : `${fmtSize(b)}/s`; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ---------- rendering (dlman-inspired incremental paint) ----------
   Progress events carry the row numbers → paint in place, no IPC per tick.
   Structural changes (add/remove/list shape) → debounced diff refresh.
   A slow poll keeps everything honest if an event is ever missed. */

let jobMap = new Map(); // id -> {j, el}

function rowFor(j) {
  let item = jobMap.get(j.id);
  if (!item) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div class="f-name" title="${esc(j.name)}">${esc(j.name)}</div><div class="f-desc" title="${esc(j.url)}">${esc(j.url)}</div></td>
      <td class="size">${fmtSize(j.total)}</td>
      <td class="pcol"><div class="prog"><i></i></div><span class="pct">0%</span></td>
      <td class="scol"></td>
      <td class="spd"></td>
      <td class="ops">
        <button class="icon" data-op="pause" title="Pause">⏸</button>
        <button class="icon" data-op="resume" title="Resume">▶</button>
        <button class="icon" data-op="open" title="Open file / folder">📂</button>
        <button class="icon danger" data-op="remove" title="Remove">🗑</button>
      </td>`;
    rows.appendChild(tr);
    const id = j.id;
    tr.querySelectorAll(".ops button").forEach(btn => {
      btn.onclick = async () => {
        const op = btn.dataset.op;
        if (op === "pause") await invoke("pause_job", { id });
        if (op === "resume") await invoke("resume_job", { id });
        if (op === "open") await invoke("open_file", { id }).catch(() => invoke("open_folder", { id }));
        if (op === "remove") await invoke("remove_job", { id, delFiles: false });
        scheduleRefresh(0);
      };
    });
    item = { j, el: tr };
    jobMap.set(j.id, item);
  }
  item.j = j;
  paintRow(j);
  return item;
}

function removeRow(id) {
  const item = jobMap.get(id);
  if (item) { item.el.remove(); jobMap.delete(id); }
}

// structural sync: add missing, paint existing, drop gone — no teardown
function renderAll(jobs) {
  const seen = new Set();
  for (const j of jobs) { rowFor(j); seen.add(j.id); }
  for (const id of [...jobMap.keys()]) if (!seen.has(id)) removeRow(id);
  empty.classList.toggle("hidden", jobs.length !== 0);
  updateCounters(jobs);
  folderLabel.textContent = jobs[0]?.folder || "—";
}

function paintRow(j) {
  const item = jobMap.get(j.id);
  if (!item) return;
  const tr = item.el;
  item.j = j;

  const [stateName, cls] = STATE[j.state] ?? ["?", "b-queued"];
  const running = j.state === 2;
  const error = j.error ? `title="${esc(j.error)}"` : "";

  tr.querySelector(".size").textContent = fmtSize(j.total);
  const bar = tr.querySelector(".prog i");
  const pct = j.total > 0 ? Math.min(100, Math.round(j.done / j.total * 100)) : (running ? 0 : 0);
  bar.style.width = `${pct}%`;
  tr.querySelector(".pct").textContent = `${pct}%`;
  tr.querySelector(".scol").innerHTML = `<span class="badge ${cls}" ${error}>${stateName}</span>`;
  tr.querySelector(".spd").textContent = fmtSpeed(j.speed);
  tr.style.opacity = j.state === 4 ? 0.65 : 1;
  tr.title = j.error ?? "";

  // ops visibility
  const set = (op, on) => tr.querySelector(`[data-op=${op}]`).classList.toggle("hidden", !on);
  set("pause", running);
  set("resume", j.state === 1 || j.state === 3 || j.state === 5);
}

function updateCounters(jobs) {
  const active = jobs.filter(j => j.state === 1 || j.state === 2).length;
  const done = jobs.filter(j => j.state === 4).length;
  counters.textContent = `${active} active · ${done} done`;
}

/* ---------- data flow ---------- */

let refreshT = 0;
function scheduleRefresh(ms = 250) { // debounce: several events → one sync
  clearTimeout(refreshT);
  refreshT = setTimeout(refresh, ms);
}

async function refresh() {
  try {
    const jobs = await invoke("list_jobs");
    renderAll(jobs);
    const s = await invoke("get_settings").catch(() => null);
    if (s) folderLabel.textContent = s.download_dir;
  } catch (e) { console.warn("refresh failed", e); }
}

// progress tick: paint straight from the event payload (zero IPC, dlman style)
function paintProgress(p) {
  const item = jobMap.get(p.id);
  if (!item) { scheduleRefresh(); return; } // new row not diffed yet
  const j = { ...item.j, done: p.done, total: p.total, speed: p.speed };
  item.j = j;
  paintRow(j);
}

// state change: repaint badge instantly, then diff the list shortly after
function paintState(p) {
  const item = jobMap.get(p.id);
  if (item) {
    item.j = { ...item.j, state: p.state, name: p.name, error: p.error };
    paintRow(item.j);
  }
  scheduleRefresh();
}

if (event?.listen) {
  event.listen("job-update", (e) => {
    const p = e.payload || {};
    if (p.type === "progress") paintProgress(p);
    else if (p.type === "state") paintState(p);
    else scheduleRefresh();
  });
}

setInterval(refresh, 1500); // resilience net: counters + anything missed

/* ---------- dialogs ---------- */

function openDlg(id) { document.getElementById(id).classList.remove("hidden"); }
function closeDlg(id) { document.getElementById(id).classList.add("hidden"); }

document.getElementById("btn-add").onclick = () => { document.getElementById("add-url").value = urlbox.value || ""; openDlg("dlg-add"); document.getElementById("add-url").focus(); };
document.getElementById("add-cancel").onclick = () => closeDlg("dlg-add");
document.getElementById("add-ok").onclick = async () => {
  const url = document.getElementById("add-url").value.trim();
  const folder = document.getElementById("add-folder").value.trim() || null;
  const name = document.getElementById("add-name").value.trim() || null;
  if (url) await invoke("add_download", { url, referer: null, filename: name, folder });
  closeDlg("dlg-add");
  refresh();
};

document.getElementById("btn-settings").onclick = async () => {
  const s = await invoke("get_settings");
  document.getElementById("set-folder").value = s.download_dir;
  document.getElementById("set-port").value = s.port;
  document.getElementById("set-segs").value = s.max_segments;
  document.getElementById("set-ua").value = s.user_agent;
  document.getElementById("set-takeover").checked = !!s.integrate_takeover;
  openDlg("dlg-settings");
};
document.getElementById("set-cancel").onclick = () => closeDlg("dlg-settings");
document.getElementById("set-ok").onclick = async () => {
  await invoke("save_settings", {
    port: Number(document.getElementById("set-port").value) || 9100,
    maxSegments: Number(document.getElementById("set-segs").value) || 8,
    downloadDir: document.getElementById("set-folder").value.trim(),
    userAgent: document.getElementById("set-ua").value.trim(),
    integrateTakeover: document.getElementById("set-takeover").checked,
  });
  closeDlg("dlg-settings");
  refresh();
};

document.getElementById("btn-folder").onclick = () => invoke("open_folder", { id: null });

const urlbox = document.getElementById("urlbox");
urlbox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && urlbox.value.trim()) {
    invoke("add_download", { url: urlbox.value.trim(), referer: null, filename: null, folder: null }).then(() => { urlbox.value = ""; refresh(); });
  }
});

/* ---------- boot ---------- */
renderAll([]);
refresh().then(() => {
  invoke("get_settings").then(s => { folderLabel.textContent = s.download_dir; }).catch(() => {});
});
