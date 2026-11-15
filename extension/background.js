// OpenDM Integration — background service worker (MV3) v1.1
// Channels: WebSocket primary, native messaging fallback (like IDM).
// Media: <video>/<audio> surfaces are surfaced by the content script; this
// worker also observes media requests (webRequest) so streamed or blob
// players still yield a downloadable candidate URL, like IDM does.

const DEFAULTS = { port: 9100, takeover: true, enabled: true };
let cfg = { ...DEFAULTS };
async function loadCfg() { try { Object.assign(cfg, await chrome.storage.local.get(DEFAULTS)); } catch {} }
loadCfg();
chrome.storage.onChanged?.addListener((ch, area) => {
  if (area === "local") {
    if (ch.enabled) {
      cfg.enabled = !!ch.enabled.newValue;
      setBadgeGlobal(cfg.enabled ? "" : "off");
    }
    if (!ch.enabled) loadCfg();
  }
});

function setBadgeGlobal(text) {
  try {
    if (text) chrome.action.setBadgeBackgroundColor({ color: "#94a3b8" }).catch?.(() => {});
    chrome.action.setBadgeText({ text }).catch?.(() => {});
  } catch {}
}

/* ---------------- transport: WS primary, NM fallback ---------------- */

const WS_PROTO = "plugin.v3.opendm.local";
let ws = null;
let wsAttempts = 0;
let natPort = null;

function getPort() { try { return cfg.port ?? 9100; } catch { return 9100; } }

function wsURL() {
  const cid = (chrome.runtime.id || "ext").slice(0, 8);
  const rnd = Math.random().toString().substring(2, 10);
  return `ws://127.0.0.1:${getPort()}/?cid=${cid}&rnd=${rnd}`;
}

function scheduleReconnect() {
  if (ws) return;
  wsAttempts++;
  const delay = Math.min(8000, 500 * wsAttempts);
  setTimeout(connectWS, delay);
}

function connectWS() {
  if (ws) return;
  try {
    ws = new WebSocket(wsURL(), WS_PROTO);
    ws.binaryType = "blob";
    ws.onopen = () => { wsAttempts = 0; };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onmessage = () => {};
  } catch {
    ws = null;
    scheduleReconnect();
  }
}
connectWS();

function connectNM() {
  if (natPort) return natPort;
  try {
    natPort = chrome.runtime.connectNative("app.opendm.host");
    natPort.onDisconnect.addListener(() => { natPort = null; });
    natPort.onMessage.addListener(() => {});
    return natPort;
  } catch { natPort = null; return null; }
}

function sendToApp(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  } catch {}
  const p = connectNM();
  if (p) { try { p.postMessage(obj); return true; } catch {} }
  return false;
}

async function harvestCookies(url) {
  try {
    const c = await chrome.cookies.getAll({ url });
    if (!c || !c.length) return null;
    return c.map((x) => `${x.name}=${x.value}`).join("; ");
  } catch { return null; }
}

/* Turn a page title into a sane download name (IDM-style: page title beats URL).
   Strips "- SiteName" tails (domain words from the page URL), then window-illegal chars. */
function titleToName(title, pageUrl = null) {
  if (!title) return null;
  let t = String(title).trim();
  if (!t) return null;
  try {
    if (pageUrl) {
      const host = new URL(pageUrl).hostname.replace(/^(www|m|mobile)\./, "");
      const words = host
        .split(/[.-]/)
        .filter((w) => w.length >= 3 &&
          !/^(com|net|org|edu|tv|io|co|cc|to|me|app|cdn|stream|live|watch|player|video|page|site|www|m)$/i.test(w));
      if (words.length) {
        // "… - SiteName - watch" → "…"; runs interleaved with the noise strip below
        const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        const brand = new RegExp("[\\s\\-–—|:·]+(?:" + esc + ")[\\s\\-–—|:·]*$", "i");
        const noise = /\s*[-–—|:·]?\s*(?:(watch|stream)(ing)?\s*(free\s*)?(hd\s*)?(online|now|movie|video)(\s+(in|on)\s*hd)?|full(\s*hd)?\s*(video|episode|movie)|official\s*(video|trailer)|online\s*(free)|free\s*(online)|hd|4k|1080p|720p)\s*$/i;
        let prev = null;
        for (let i = 0; i < 6 && t !== prev; i++) {
          prev = t;
          // collapse duplicated segments: "Title - Title - extra" → "Title - extra"
          const segs = t.split(/\s+[-–—|:·]\s+/);
          if (segs.length > 1 && !/^(full|hd|4k|1080p)$/i.test(segs[0])) {
            const out = [segs[0]];
            for (let i2 = 1; i2 < segs.length; i2++) {
              if (segs[i2].toLowerCase() !== out[out.length - 1].toLowerCase()) out.push(segs[i2]);
            }
            if (out.length < segs.length) t = out.join(" - ");
          }
          t = t.replace(noise, "").trim().replace(brand, "").trim();
        }
      }
    }
  } catch {}
  // Windows-illegal chars → space
  t = t.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 120) { t = t.slice(0, 120).trim(); }
  return t || null;
}

async function addDownload({ url, referer = null, filename = null, op = "add" }) {
  if (!cfg.enabled) return { ok: false, error: "Integration disabled — click the OpenDM toolbar icon to enable." };
  const scheme = (url || "").toLowerCase().split(":")[0];
  if (!["http", "https", "ftp"].includes(scheme)) return { ok: false, error: "unsupported scheme" };
  const cookies = await harvestCookies(url); // IDM parity: send the browser cookies along
  const sent = sendToApp({ op, url, referer, filename, ...(cookies ? { cookies } : {}) });
  return sent ? { ok: true } : { ok: false, error: "OpenDM not reachable — is OpenDM.exe running?" };
}

function directOk(u) { return /^https?:\/\//i.test(u || "") && !/^blob:/i.test(u || ""); }

/* ---------------- media sniffing (IDM-style) ---------------- */

const BADGE_COLOR = "#2563eb";
const tabMedia = new Map(); // tabId -> { urls: Map<url, meta>, best: url|null, ts }

function classifyURL(url, mime) {
  const u = url || "";
  if (/\.m3u8(\?|$)/i.test(u) || /\/api\/manifest\/hls_playlist\//i.test(u) || /mpegurl/i.test(mime || "")) return "hls";
  if (/\.mpd(\?|$)/i.test(u) || /dash\+xml/i.test(mime || "")) return "dash";
  if (/\.ts(\?|$)/i.test(u) || /\.m4s(\?|$)/i.test(u) || /MP2T/i.test(mime || "")) return "seg";
  if (/^(video|audio)\//i.test(mime || "")) return "file";
  // YouTube player streams + manifests (URLs carry no file extension).
  // SABR server-ABR URLs (sabr=1) need a POST body with protobuf stream config;
  // a plain GET returns a ~31-byte protobuf error (sabr.malformed_config), so
  // they are never offered as direct downloads.
  if (/\/videoplayback(\?|$)/i.test(u)) {
    if (/(?:^|[?&])sabr=1(?:&|$)/i.test(u)) return "sabr";
    return "file";
  }
  if (/\/(api_)?video_info(\?|$)/i.test(u) && /\.youtube\.com$|\.googlevideo\.com/i.test((u.split("/")[2] || "").split("?")[0])) return "file";
  if (/\.(mp4|webm|m4v|mov|mkv|mp3|m4a|flac|ogg|wav|aac|3gp)(\?|$)/i.test(u)) return "file";
  return null;
}

function setBadge(tabId, text) {
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch?.(() => {});
    chrome.action.setBadgeText({ tabId, text }).catch?.(() => {});
  } catch {}
}

function noteMedia(tabId, url, meta) {
  if (tabId < 0 || !directOk(url)) return;
  let e = tabMedia.get(tabId);
  if (!e) { e = { urls: new Map(), best: null, ts: Date.now() }; tabMedia.set(tabId, e); }
  e.ts = Date.now();
  const fresh = !e.urls.has(url);
  const m = e.urls.get(url) || {};
  if (meta.mime) m.mime = meta.mime;
  if (meta.len) m.len = meta.len;
  if (!m.kind) m.kind = meta.kind || classifyURL(url, meta.mime);
  m.ts = Date.now();
  e.urls.set(url, m);
  // prune
  const now = Date.now();
  const keep = [...e.urls.entries()].filter(([, v]) => now - v.ts < 15 * 60000).slice(-40);
  e.urls = new Map(keep);
  if (fresh && m.kind === "file") setBadge(tabId, "▸");
  // best candidate tracking: downloadable container files preferred
  if (m.kind === "file" && (e.best == null || !isBetterMime(m, e.urls.get(e.best)))) e.best = url;
}

function isBetterMime(a, b) {
  if (!b) return true;
  const av = (a.len || 0), bv = (b.len || 0);
  if (!b.mime && a.mime) return true;
  return av > bv;
}

function bestFor(tabId) {
  const e = tabMedia.get(tabId);
  if (!e) return null;
  if (e.best && e.urls.get(e.best)) return { url: e.best, meta: e.urls.get(e.best) };
  // fall back to the best downloadable file we saw
  let pick = null;
  for (const [u, m] of e.urls) {
    if (m.kind !== "file") continue;
    if (!pick || (m.len || 0) > (e.urls.get(pick).len || 0)) pick = u;
  }
  return pick ? { url: pick, meta: e.urls.get(pick) } : null;
}

chrome.webRequest?.onBeforeRequest?.addListener(
  (det) => {
    if (!det || det.tabId < 0) return;
    if (/^(blob:|data:)/i.test(det.url)) return;
    const kind = classifyURL(det.url, null);
    if (kind) noteMedia(det.tabId, det.url, { kind });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

chrome.webRequest?.onHeadersReceived?.addListener(
  (det) => {
    if (!det || det.tabId < 0) return;
    if (/^(blob:|data:)/i.test(det.url)) return;
    const mime = (det.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type")?.value;
    const kind = classifyURL(det.url, mime || "");
    if (!kind) return;
    const len = +( (det.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-length")?.value || 0 );
    noteMedia(det.tabId, det.url, { kind, mime, len });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs?.onUpdated?.addListener((tabId, info, _tab) => {
  if (info.status === "loading") {
    tabMedia.delete(tabId);
    setBadge(tabId, "");
  }
});
chrome.tabs?.onRemoved?.addListener((tabId) => tabMedia.delete(tabId));

function playerStream(u) {
  return /\/videoplayback(\?|$)/i.test(u || "") || /\/api\/manifest\/hls_playlist\//i.test(u || "");
}

/* ---------------- message handling ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.op === "media-found") {
    const t = sender.tab ? sender.tab.id : -1;
    noteMedia(t, msg.url, { kind: classifyURL(msg.url, null) });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.op === "media" || msg.op === "media-pick") {
    (async () => {
      const t = sender.tab ? sender.tab.id : -1;
      let why = null;

      // YouTube: the extension only sends the page URL; the app runs the
      // yt-dlp pipeline (parse stage → quality dialog → download).
      const isYtPage = msg.yt || /^(?:www\.|m\.)?(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/i.test((msg.url || "").replace(/^https?:\/\//i, ""));
      if (isYtPage) {
        const r = await addDownload({ url: msg.url, referer: sender.pageUrl || msg.tabUrl || null, op: "add" });
        sendResponse({ ok: r.ok, yt: true, error: r.error });
        return;
      }

      // candidate URLs: what the page reported + what we sniffed.
      // A sniffed HLS manifest beats <video> blob: URLs (voe/vidmoly players).
      const cands = [];
      if (directOk(msg.url)) cands.push(msg.url);
      const e = tabMedia.get(t);
      if (e) {
        let hlsUrl = null;
        for (const [u, m] of e.urls) {
          if (m.kind === "hls" || /\.m3u8(\?|#|$)/i.test(u) || /\/api\/manifest\/hls_playlist\//i.test(u)) hlsUrl = u; // newest wins
        }
        if (hlsUrl) cands.unshift(hlsUrl);
      }
      const best = bestFor(t);
      if (best) cands.push(best.url);

      // HLS first: manifest candidates are fetched + classified (master vs media playlist)
      for (const u of cands) {
        if (!/^https?:/i.test(u) || !(/\.m3u8/i.test(u) || /\/api\/manifest\/hls_playlist\//i.test(u))) continue;
        const cls = await probeHls(u);
        if (cls && cls.kind === "media") {
          const r = await addDownload({ url: u, referer: sender.pageUrl || msg.tabUrl || null, filename: titleToName(sender.tab ? sender.tab.title : null, sender.pageUrl || msg.tabUrl || null), op: "add" });
          sendResponse({ ok: r.ok, url: u, error: r.error });
          return;
        }
        if (cls && cls.kind === "master") {
          // let the content script show the IDM-style quality menu
          sendResponse({ ok: true, hls: true, variants: cls.variants });
          return;
        }
        why = "HLS stream detected, but its playlist could not be read (site may block direct fetch). Try again while the video plays.";
      }

      let url = null;
      if (directOk(msg.url)) url = msg.url;
      else if (best && best.meta?.kind === "file") url = best.url;
      else if (best) why = why || "That video looks like an HLS/DASH stream — OpenDM can't fetch it yet.";
      else why = why || "No downloadable stream found yet — let the video play a couple of seconds and try again.";
      if (!url) { sendResponse({ ok: false, error: why }); return; }
      // player URLs (YouTube videoplayback) get the page-title name, like HLS adds
      const fn = playerStream(url) ? titleToName(sender.tab ? sender.tab.title : null, sender.pageUrl || msg.tabUrl || null) : null;
      const r = await addDownload({ url, referer: sender.pageUrl || msg.tabUrl || null, filename: fn, op: "add" });
      sendResponse({ ok: r.ok, url, error: r.error });
    })();
    return true; // async response
  }

  /* quality menu choice → download that exact variant (engine treats .m3u8 as HLS) */
  if (msg.op === "hls-pick") {
    (async () => {
      const r = await addDownload({ url: msg.url, referer: msg.tabUrl || sender.pageUrl || null, filename: titleToName(sender.tab ? sender.tab.title : null, msg.tabUrl || sender.pageUrl || null), op: "add" });
      sendResponse({ ok: r.ok, url: msg.url, error: r.error });
    })();
    return true;
  }

  return false;
});

/* fetch an .m3u8 and classify it: master (with variants) or media playlist */
async function probeHls(url) {
  try {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!/^#EXTM3U/m.test(text)) return null;
    if (!text.includes("#EXT-X-STREAM-INF")) return { kind: "media" };
    const lines = text.split("\n").map((l) => l.trim());
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF/.test(lines[i])) continue;
      const attrs = lines[i].slice(lines[i].indexOf(":") + 1);
      const res = /RESOLUTION="?(\d+)x(\d+)/i.exec(attrs);
      const bw = Number((/BANDWIDTH=(\d+)/i.exec(attrs) || [])[1] || 0);
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
      if (j >= lines.length) break;
      let vurl = lines[j];
      try { vurl = new URL(lines[j], url).href; } catch {}
      variants.push({
        label: res ? `${res[2]}p` : (bw ? `${Math.round(bw / 1000)} kbps` : `variant ${variants.length + 1}`),
        url: vurl,
        bandwidth: bw,
      });
      i = j;
    }
    if (!variants.length) return null;
    variants.sort((a, b) => b.bandwidth - a.bandwidth); // best first (IDM order)
    return { kind: "master", variants };
  } catch {
    return null;
  }
}

/* ---------------- action button: toggle integration (like IDM) ---------------- */

chrome.action?.onClicked?.addListener(async () => {
  await loadCfg();
  cfg.enabled = !cfg.enabled;
  chrome.storage.local.set({ enabled: cfg.enabled });
  setBadgeGlobal(cfg.enabled ? "" : "off");
});

/* ---------------- context menus ---------------- */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "opdm-link", title: "Download this link with OpenDM", contexts: ["link"] });
    chrome.contextMenus.create({ id: "opdm-image", title: "Download this image with OpenDM", contexts: ["image"] });
    chrome.contextMenus.create({ id: "opdm-video", title: "Download this media with OpenDM", contexts: ["video", "audio"] });
    chrome.contextMenus.create({ id: "opdm-selection", title: "Download selected links with OpenDM", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "opdm-all", title: "Grab all links on this page with OpenDM", contexts: ["page"] });
    chrome.contextMenus.create({ id: "opdm-takeover", title: "Send this page to OpenDM (open in app)", contexts: ["page"] });
  });
}
chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup?.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const referer = info.pageUrl || (tab && tab.url) || null;
  if (info.menuItemId === "opdm-link" && info.linkUrl) {
    addDownload({ url: info.linkUrl, referer, op: "add" });
  } else if (info.menuItemId === "opdm-image" && info.srcUrl) {
    addDownload({ url: info.srcUrl, referer, op: "add" });
  } else if (info.menuItemId === "opdm-video" && (info.srcUrl || info.frameUrl)) {
    const u = info.srcUrl && !/^blob:/i.test(info.srcUrl) ? info.srcUrl : null;
    // player URLs (YouTube videoplayback) and HLS manifests get a page-title name; direct media files keep their URL name
    const fn = (/\.m3u8/i.test(u) || playerStream(u)) ? titleToName(tab ? tab.title : null, referer) : null;
    if (u) addDownload({ url: u, referer, ...(fn ? { filename: fn } : {}), op: "add" });
    else if (tab) {
      // blob<video>: use the sniffed candidate of the tab, like the button does
      const best = bestFor(tab.id ?? -1);
      if (best && best.meta?.kind === "file") addDownload({ url: best.url, referer, op: "add" });
    }
  } else if (info.menuItemId === "opdm-selection") {
    const text = (info.selectionText || "");
    const urls = [...new Set((text.match(/https?:\/\/[^\s"'<>()]+/g) || []))];
    for (const u of urls.slice(0, 60)) addDownload({ url: u, referer, op: "add" });
  } else if (info.menuItemId === "opdm-all") {
    if (tab?.id != null) {
      chrome.tabs.sendMessage(tab.id, { op: "grab-links", pageUrl: info.pageUrl })
        .then((resp) => {
          const links = (resp && resp.links) || [];
          for (const l of links.slice(0, 60)) addDownload({ url: l, referer, op: "add" });
        })
        .catch(() => {});
    }
  } else if (info.menuItemId === "opdm-takeover" && info.pageUrl) {
    addDownload({ url: info.pageUrl, referer, op: "add" });
  }
});

/* ---------------- download takeover (like IDM) ---------------- */

chrome.downloads?.onCreated?.addListener(async (item) => {
  await loadCfg();
  if (!cfg.takeover || !cfg.enabled) return;
  const url = (item.finalUrl || item.url || "");
  if (!url) return;
  const lowUrl = url.toLowerCase();
  if ((item.mime || "").includes("text/html") || lowUrl.includes("text/html")) return;
  try {
    await addDownload({ url, referer: null, op: "takeover", filename: item.filename ? item.filename.split(/[\\/]/).pop() : null });
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (e) {
    console.warn("OpenDM takeover failed", e);
  }
});
