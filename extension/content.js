// OpenDM Integration — content script
// IDC-like behavior: when the user plays a video, a floating "Download this
// video" button appears pinned to the video's corner (like IDM's panel).
(function () {
  if (window.__opdmContentInit) return;
  window.__opdmContentInit = true;

  const OVERLAYS = new Map(); // el -> {holder, btn}
  const REPORTED = new Set(); // urls already beamed to background (dedup)
  const HIDDEN = new Map();   // el -> ts until which overlay stays hidden

  /* ---------------- helpers ---------------- */

  function mediaURL(el) {
    try { return el.currentSrc || el.src || null; } catch { return null; }
  }
  function directURL(u) { return /^https?:\/\//i.test(u || ""); }
  function isMarkdown(u) { return /\.(mp4|webm|m4v|mov|mkv|mp3|m4a|flac|ogg|wav|aac|3gp)(\?|$)/i.test(u || ""); }

  function report(url) {
    if (!directURL(url) || REPORTED.has(url)) return;
    REPORTED.add(url);
    if (REPORTED.size > 400) REPORTED.clear();
    try { chrome.runtime.sendMessage({ op: "media-found", url, pageUrl: location.href }, () => void chrome.runtime.lastError); } catch {}
  }

  /* ---------------- toast ---------------- */

  function toast(msg) {
    let t = document.getElementById("__opdm-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "__opdm-toast";
      t.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:28px;z-index:2147483645;max-width:70vw;padding:10px 16px;border-radius:10px;background:#0e1a2f;color:#fff;font:13px/1.4 'Segoe UI',sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);transition:opacity .25s;opacity:0;pointer-events:none;";
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(toast.__t);
    toast.__t = setTimeout(() => { t.style.opacity = "0"; }, 2600);
  }

  /* ---------------- floating download button ---------------- */

  function ensureOverlay(el) {
    let s = OVERLAYS.get(el);
    if (s) return s;
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;z-index:2147483600;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .18s;pointer-events:none;";
    const pick = document.createElement("button");
    pick.textContent = el.tagName === "VIDEO" ? "Download this video with OpenDM" : "Download this audio with OpenDM";
    pick.title = "Send to OpenDM";
    pick.style.cssText = "padding:6px 12px;border:0;border-radius:16px;background:rgba(14,26,47,.92);color:#fff;font:600 12px/1.2 'Segoe UI',sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);white-space:nowrap;";
    pick.addEventListener("mouseenter", () => { pick.style.background = "rgba(37,99,235,.95)"; });
    pick.addEventListener("mouseleave", () => { pick.style.background = "rgba(14,26,47,.92)"; });
    pick.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (isYouTubeWatch()) {
        // YouTube rides the yt-dlp pipeline in the app: the extension only
        // sends the page URL (parse stage shows the quality dialog there).
        toast("YouTube link sent to OpenDM…");
        chrome.runtime.sendMessage({ op: "media-pick", url: location.href, tabUrl: location.href, yt: true }, (resp) => {
          void chrome.runtime.lastError;
          if (resp && resp.ok) toast("Preparing YouTube download in OpenDM…");
          else if (resp) toast(resp.error || "OpenDM could not receive the link.");
          else toast("OpenDM is not reachable (each channel offline). Is OpenDM.exe running?");
        });
        return;
      }
      const u = mediaURL(el);
      chrome.runtime.sendMessage({ op: "media-pick", url: u, tabUrl: location.href }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.hls && resp.variants && resp.variants.length) showQualityMenu(resp.variants, el);
        else if (resp && resp.ok) toast("Sent to OpenDM: " + shortName(resp.url));
        else if (resp) toast(resp.error || "No downloadable stream found yet.");
        else toast("OpenDM is not reachable (each channel offline). Is OpenDM.exe running?");
      });
    });
    const close = document.createElement("span");
    close.textContent = "×";
    close.title = "Hide this button (10 min)";
    close.style.cssText = "width:18px;height:18px;border-radius:50%;background:rgba(14,26,47,.85);color:#cbd5e1;font:600 12px/18px Arial;text-align:center;cursor:pointer;user-select:none;";
    close.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); HIDDEN.set(el, Date.now() + 600000); });
    holder.appendChild(pick); holder.appendChild(close);
    (document.body || document.documentElement).appendChild(holder);
    s = { holder, pick };
    OVERLAYS.set(el, s);
    return s;
  }

  function shortName(u) {
    try { return decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || u).slice(0, 60); }
    catch { return (u || "").slice(0, 60); }
  }

  function isYouTubeWatch() {
    try {
      if (!/(^|\.)(youtube|youtube-nocookie)\.com$/.test(location.hostname)) return false;
      return location.pathname === "/watch" || location.pathname.startsWith("/embed");
    } catch { return false; }
  }

  /* ---------------- IDM-style quality menu (480p / 720p / 1080p…) ---------------- */

  function showQualityMenu(variants, anchorEl) {
    const menu = document.createElement("div");
    menu.style.cssText = "position:fixed;z-index:2147483601;background:rgba(14,26,47,.97);border:1px solid rgba(255,255,255,.14);border-radius:10px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.55);min-width:190px;font:600 12px/1.2 'Segoe UI',sans-serif;";
    const head = document.createElement("div");
    head.textContent = "Download quality — OpenDM";
    head.style.cssText = "padding:8px 12px;color:#93c5fd;background:rgba(37,99,235,.22);letter-spacing:.3px;";
    menu.appendChild(head);
    variants.forEach((v) => {
      const b = document.createElement("button");
      b.textContent = "Download " + v.label;
      b.style.cssText = "display:block;width:100%;text-align:left;padding:9px 12px;background:transparent;border:0;color:#e2e8f0;cursor:pointer;font:inherit;";
      b.addEventListener("mouseenter", () => { b.style.background = "rgba(37,99,235,.55)"; });
      b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        menu.remove();
        document.removeEventListener("click", dismiss, true);
        chrome.runtime.sendMessage({ op: "hls-pick", url: v.url, tabUrl: location.href }, (resp) => {
          void chrome.runtime.lastError;
          if (resp && resp.ok) toast("Sent to OpenDM: " + v.label);
          else toast((resp && resp.error) || "OpenDM is not reachable.");
        });
      });
      menu.appendChild(b);
    });
    (document.body || document.documentElement).appendChild(menu);
    // position over the video (top-right), clamped to the viewport
    try {
      const r = (anchorEl && anchorEl.getBoundingClientRect()) || { right: innerWidth - 20, top: 40 };
      let x = r.right - menu.offsetWidth, y = Math.max(8, (r.top || 40) + 46);
      x = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8));
      y = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8));
      menu.style.left = x + "px"; menu.style.top = y + "px";
    } catch { menu.style.right = "16px"; menu.style.top = "48px"; }
    const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", dismiss, true); } };
    setTimeout(() => document.addEventListener("click", dismiss, true), 0);
  }

  function positionOverlays() {
    const now = Date.now();
    if (!integrationOn) return;
    OVERLAYS.forEach((s, el) => {
      try {
        const rect = el.getBoundingClientRect();
        const gone = !document.documentElement.contains(el) || rect.width < 24 || rect.height < 24;
        if (gone || (HIDDEN.get(el) || 0) > now) {
          s.holder.style.opacity = "0"; s.holder.style.pointerEvents = "none";
          if (gone) { s.holder.remove(); OVERLAYS.delete(el); }
          return;
        }
        // show when playing, or when the pointer is on the video
        const playing = !el.paused && !el.ended && el.readyState >= 2;
        const hovered = el.matches(":hover");
        if (!playing && !hovered) {
          s.holder.style.opacity = "0"; s.holder.style.pointerEvents = "none";
          return;
        }
        s.holder.style.pointerEvents = "auto";
        s.holder.style.opacity = "1";
        const r = s.holder.getBoundingClientRect();
        let left = rect.right - r.width - 14;
        let top = rect.top + 10;
        left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
        top = Math.max(8, Math.min(top, innerHeight - r.height - 8));
        s.holder.style.left = `${left}px`;
        s.holder.style.top = `${top}px`;
      } catch {
        s.holder.style.opacity = "0";
      }
    });
  }

  function found(el) {
    const u = mediaURL(el);
    if (u && directURL(u)) report(u);
    // blob/protected sources still get the button — the background worker
    // may have already sniffed a real candidate URL via webRequest.
    ensureOverlay(el);
  }

  function deepCollect(root, out, depth) {
    if (!root || depth > 6) return;
    try { root.querySelectorAll?.("video, audio").forEach((el) => out.push(el)); } catch {}
    try {
      root.querySelectorAll?.("*").forEach((n) => { if (n.shadowRoot) deepCollect(n.shadowRoot, out, depth + 1); });
    } catch {}
  }

  function scan() {
    const els = [];
    deepCollect(document, els, 0);
    els.forEach(found);
  }

  /* ---------------- element listeners ---------------- */

  function wire(el) {
    for (const ev of ["play", "loadedmetadata", "durationchange", "loadeddata"]) {
      el.addEventListener(ev, () => found(el), { passive: true });
    }
  }

  scan();
  new MutationObserver(() => {
    clearTimeout(scan.__t);
    scan.__t = setTimeout(() => {
      document.querySelectorAll("video, audio").forEach((el) => {
        if (!el.__opdmWired) { el.__opdmWired = true; wire(el); }
      });
      scan();
    }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => { if (!OVERLAYS.size) scan(); positionOverlays(); }, 300);

  /* ---------------- integration on/off (like IDM's icon toggle) ---------------- */

  let integrationOn = true;
  function applyEnabled(v) {
    integrationOn = !!v;
    if (!integrationOn) OVERLAYS.forEach((s) => { s.holder.style.opacity = "0"; s.holder.style.pointerEvents = "none"; });
  }
  chrome.storage?.local?.get({ enabled: true }, (v) => applyEnabled(v && v.enabled));
  chrome.storage?.onChanged?.addListener((ch, area) => {
    if (area === "local" && ch.enabled) applyEnabled(ch.enabled.newValue);
  });

  /* ---------------- page link-grab (context menu) ---------------- */

  chrome.runtime.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.op === "grab-links") {
      const seen = new Set();
      const links = [];
      document.querySelectorAll("a[href]").forEach((a) => {
        let href;
        try { href = a.href; } catch { return; }
        if (!/^https?:\/\//i.test(href) || seen.has(href)) return;
        seen.add(href);
        links.push(href);
      });
      sendResponse({ links: links.slice(0, 60) });
      return false;
    }
    return false;
  });
})();
