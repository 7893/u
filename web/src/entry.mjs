import Uppy from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import zh_CN from "@uppy/locales/lib/zh_CN.js";

import "./style.css";

const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB per file
const $ = (id) => document.getElementById(id);
const PAGE_ENTER_TS = Date.now();
const PAGE_ENTER_PERF = performance.now();

function randHex(bytesLen = 8) {
  const arr = new Uint8Array(bytesLen);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getOrCreateVid() {
  try {
    let v = localStorage.getItem("u_vid");
    if (!v || !/^[0-9a-f]{16,32}$/.test(v)) {
      v = randHex(12);
      localStorage.setItem("u_vid", v);
    }
    return v;
  } catch (_) {
    return randHex(12);
  }
}

const VID = getOrCreateVid();
const SID = randHex(8);
let eventSeq = 0;
let cachedProfilePromise = null;

function getWebGLInfo() {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const info = {
      webgl_ver:
        typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
          ? "webgl2"
          : "webgl1",
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      max_tex_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return info;
  } catch (_) {
    return null;
  }
}

async function getCanvasHash() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 44;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fbbc04";
    ctx.fillRect(10, 4, 80, 24);
    ctx.fillStyle = "#0b57d0";
    ctx.font = "15px Arial, sans-serif";
    ctx.fillText("u-fp-2026 中文 AaBb", 6, 22);
    ctx.strokeStyle = "#34a853";
    ctx.arc(170, 22, 14, 0, Math.PI * 1.6);
    ctx.stroke();
    const raw = canvas.toDataURL();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch (_) {
    return null;
  }
}

function detectOSFonts() {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const sample = "mmmmmmmmmmlli中文测试";
    const bases = ["monospace", "sans-serif", "serif"];
    const baseW = {};
    for (const b of bases) {
      ctx.font = `36px ${b}`;
      baseW[b] = ctx.measureText(sample).width;
    }
    const candidates = [
      "PingFang SC",
      "Hiragino Sans GB",
      "Heiti SC",
      "SF Pro Text",
      "Microsoft YaHei",
      "SimSun",
      "Segoe UI",
      "HarmonyOS Sans",
      "HarmonyOS Sans SC",
      "MiSans",
      "Roboto",
      "Noto Sans CJK SC",
      "Source Han Sans SC",
      "Ubuntu",
    ];
    const found = [];
    for (const f of candidates) {
      for (const b of bases) {
        ctx.font = `36px "${f}", ${b}`;
        if (ctx.measureText(sample).width !== baseW[b]) {
          found.push(f);
          break;
        }
      }
    }
    return found;
  } catch (_) {
    return [];
  }
}

function mq(q) {
  try {
    return window.matchMedia ? window.matchMedia(q).matches : null;
  } catch (_) {
    return null;
  }
}

async function collectVisitorProfile() {
  const intl = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions();
    } catch (_) {
      return {};
    }
  })();

  let uaHighEntropy = null;
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      uaHighEntropy = await navigator.userAgentData.getHighEntropyValues([
        "architecture",
        "bitness",
        "formFactors",
        "fullVersionList",
        "model",
        "platform",
        "platformVersion",
        "wow64",
      ]);
    }
  } catch (_) {}

  let battery = null;
  try {
    if (navigator.getBattery) {
      const b = await Promise.race([
        navigator.getBattery(),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (b) {
        battery = {
          level: typeof b.level === "number" ? Math.round(b.level * 100) / 100 : null,
          charging: !!b.charging,
        };
      }
    }
  } catch (_) {}

  let storage = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      storage = {
        quota_mb: est.quota ? Math.round(est.quota / 1048576) : null,
        usage_mb: est.usage ? Math.round((est.usage / 1048576) * 100) / 100 : 0,
      };
    }
  } catch (_) {}

  let navPerf = null;
  try {
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (nav) {
      navPerf = {
        type: nav.type,
        protocol: nav.nextHopProtocol || null,
        dns_ms: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
        tcp_ms: Math.round(nav.connectEnd - nav.connectStart),
        tls_ms: nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : 0,
        ttfb_ms: Math.round(nav.responseStart - nav.requestStart),
        dom_ready_ms: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      };
    }
  } catch (_) {}

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const canvasHash = await getCanvasHash();

  return {
    client_time: new Date().toISOString(),
    tz: intl.timeZone || null,
    tz_offset_min: new Date().getTimezoneOffset(),
    locale: intl.locale || null,
    calendar: intl.calendar || null,
    lang: navigator.language || null,
    langs: navigator.languages ? Array.from(navigator.languages) : [],
    url: location.href,
    referrer: document.referrer || null,
    platform: navigator.platform || null,
    vendor: navigator.vendor || null,
    ua_client: navigator.userAgent || null,
    ua_high_entropy: uaHighEntropy,
    cpu_cores: navigator.hardwareConcurrency || null,
    ram_gb: navigator.deviceMemory || null,
    max_touch_points: navigator.maxTouchPoints ?? 0,
    webdriver: !!navigator.webdriver,
    pdf_viewer: navigator.pdfViewerEnabled ?? null,
    cookie_enabled: navigator.cookieEnabled ?? null,
    dnt: navigator.doNotTrack || null,
    gpc: navigator.globalPrivacyControl ?? null,
    online: navigator.onLine ?? null,
    screen: {
      w: window.screen ? window.screen.width : null,
      h: window.screen ? window.screen.height : null,
      avail_w: window.screen ? window.screen.availWidth : null,
      avail_h: window.screen ? window.screen.availHeight : null,
      color_depth: window.screen ? window.screen.colorDepth : null,
      pixel_depth: window.screen ? window.screen.pixelDepth : null,
      dpr: window.devicePixelRatio || 1,
      orientation:
        window.screen && window.screen.orientation ? window.screen.orientation.type : null,
    },
    viewport: {
      inner_w: window.innerWidth,
      inner_h: window.innerHeight,
      outer_w: window.outerWidth,
      outer_h: window.outerHeight,
    },
    display: {
      dark_mode: mq("(prefers-color-scheme: dark)"),
      hdr: mq("(dynamic-range: high)"),
      gamut_p3: mq("(color-gamut: p3)"),
      gamut_rec2020: mq("(color-gamut: rec2020)"),
      pointer_coarse: mq("(pointer: coarse)"),
      hover: mq("(hover: hover)"),
      reduced_motion: mq("(prefers-reduced-motion: reduce)"),
    },
    gpu: getWebGLInfo(),
    canvas_fp: canvasHash,
    fonts: detectOSFonts(),
    network: conn
      ? {
          effective_type: conn.effectiveType || null,
          downlink_mbps: conn.downlink ?? null,
          rtt_ms: conn.rtt ?? null,
          save_data: !!conn.saveData,
          type: conn.type || null,
        }
      : null,
    battery,
    storage,
    nav_perf: navPerf,
  };
}

function getProfile() {
  if (!cachedProfilePromise) {
    cachedProfilePromise = collectVisitorProfile();
  }
  return cachedProfilePromise;
}

async function track(event, detail = {}, preferBeacon = false) {
  try {
    const seq = ++eventSeq;
    const bodyObj = {
      vid: VID,
      sid: SID,
      seq,
      event,
      client_ts: new Date().toISOString(),
      dwell_ms: Math.round(performance.now() - PAGE_ENTER_PERF),
      detail,
    };
    if (event === "page_open") {
      bodyObj.profile = await getProfile();
    }
    const payload = JSON.stringify(bodyObj);
    const endpoint = `/u/track?ev=${encodeURIComponent(event)}&vid=${encodeURIComponent(VID)}&sid=${encodeURIComponent(SID)}`;

    if (preferBeacon && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
      if (ok) return;
    }

    await fetch(endpoint, {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      cache: "no-store",
    });
  } catch (_) {}
}

function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

async function derivePassKey(pwd) {
  const bytes = new TextEncoder().encode(`${U_GATE_PREFIX}:${pwd}`);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function classifyFile(file) {
  const name = ((file && file.name) || "").toLowerCase();
  const mime = ((file && file.type) || "").toLowerCase();
  const extMatch = name.match(/\.([a-z0-9]{1,5})$/);
  const ext = extMatch ? extMatch[1].toUpperCase() : "FILE";

  if (mime.startsWith("image/") || /^(PNG|JPG|JPEG|WEBP|GIF|HEIC|AVIF|SVG)$/.test(ext)) {
    return { label: ext.slice(0, 4), cls: "", isImg: true };
  }
  if (ext === "PDF" || mime === "application/pdf") {
    return { label: "PDF", cls: "t-pdf", isImg: false };
  }
  if (/^(ZIP|RAR|7Z|TAR|GZ|TGZ|BZ2|XZ)$/.test(ext)) {
    return { label: ext.slice(0, 4), cls: "t-arc", isImg: false };
  }
  if (mime.startsWith("video/") || /^(MP4|MOV|MKV|WEBM|AVI)$/.test(ext)) {
    return { label: ext.slice(0, 4), cls: "t-med", isImg: false };
  }
  if (/^(DOC|DOCX|XLS|XLSX|PPT|PPTX|CSV|MD|TXT|JSON)$/.test(ext)) {
    return { label: ext.slice(0, 4), cls: "t-doc", isImg: false };
  }
  return { label: ext.slice(0, 4), cls: "", isImg: false };
}

const fileUploadMeta = new Map();
const thumbUrls = new Map();

function getThumbUrl(file) {
  if (thumbUrls.has(file.id)) return thumbUrls.get(file.id);
  if (file.data && file.size && file.size <= 15 * 1048576) {
    try {
      const u = URL.createObjectURL(file.data);
      thumbUrls.set(file.id, u);
      return u;
    } catch (_) {}
  }
  return null;
}

function revokeThumb(fileId) {
  const u = thumbUrls.get(fileId);
  if (u) {
    try {
      URL.revokeObjectURL(u);
    } catch (_) {}
    thumbUrls.delete(fileId);
  }
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(str) {
  return utf8Encoder.encode(str).length;
}

function truncateUtf8Filename(safeName, maxBytes) {
  if (utf8ByteLength(safeName) <= maxBytes) return safeName;
  const dotIdx = safeName.lastIndexOf(".");
  let stem = safeName;
  let ext = "";
  if (dotIdx > 0 && dotIdx < safeName.length - 1) {
    const candidateExt = safeName.slice(dotIdx);
    const extBytes = utf8ByteLength(candidateExt);
    if (extBytes <= 32 && extBytes < maxBytes) {
      stem = safeName.slice(0, dotIdx);
      ext = candidateExt;
    }
  }
  const stemBudget = Math.max(1, maxBytes - utf8ByteLength(ext));
  let acc = "";
  let used = 0;
  for (const cp of Array.from(stem)) {
    const cpLen = utf8ByteLength(cp);
    if (used + cpLen > stemBudget) break;
    acc += cp;
    used += cpLen;
  }
  if (!acc) acc = "file";
  return acc + ext;
}

function buildUploadEndpoint(file) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  const rnd = randHex(3);
  const raw = (file && file.name) || "file.bin";
  const safe = raw.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "") || "file.bin";
  const prefix = `${ts}_${rnd}_`;
  const trimmed = truncateUtf8Filename(safe, Math.max(16, 235 - utf8ByteLength(prefix)));
  const savedName = `${prefix}${trimmed}`;
  if (file && file.id) {
    fileUploadMeta.set(file.id, { savedName, startPerf: performance.now() });
  }
  return `/u/put/${prefix}${encodeURIComponent(trimmed)}`;
}

let uppyInstance = null;
let batchUploading = false;
let wakeSentinel = null;
let toastTimer = null;
let handleSessionExpired = null;

async function acquireWake() {
  if (wakeSentinel) return;
  try {
    if (navigator.wakeLock) {
      const s = await navigator.wakeLock.request("screen");
      wakeSentinel = s;
      if (s && s.addEventListener) {
        s.addEventListener("release", () => {
          if (wakeSentinel === s) wakeSentinel = null;
        });
      }
    }
  } catch (_) {}
}

function releaseWake() {
  if (wakeSentinel) {
    const s = wakeSentinel;
    wakeSentinel = null;
    try {
      s.release();
    } catch (_) {}
  }
}

function showToast(msg) {
  const el = $("uppy-toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function svgIcon(pathD, size = 15, strokeWidth = 2) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", pathD);
  svg.appendChild(p);
  return svg;
}

function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 1) return "即将完成";
  const total = Math.ceil(seconds);
  if (total < 60) return `剩 ${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s > 0 ? `剩 ${m}分${s}秒` : `剩 ${m}分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `剩 ${h}小时${rm}分` : `剩 ${h}小时`;
}

const uploadSpeedState = {
  batchEmaBps: 0,
  batchLastBytes: 0,
  batchLastPerf: 0,
  files: new Map(), // fileId -> { emaBps, lastBytes, lastPerf, bytesUploaded, bytesTotal }
};
const renderedRowCache = new Map(); // fileId -> { li, statusKey, txtEl, fillEl }
let renderedOrderSig = "";

function resetUploadSpeedState() {
  uploadSpeedState.batchEmaBps = 0;
  uploadSpeedState.batchLastBytes = 0;
  uploadSpeedState.batchLastPerf = 0;
  uploadSpeedState.files.clear();
}

function recordFileUploadProgress(file, progress) {
  if (!file || !progress) return;
  const now = performance.now();
  const uploaded = Number(progress.bytesUploaded || 0);
  const total = Number(progress.bytesTotal || file.size || 0);
  let rec = uploadSpeedState.files.get(file.id);
  if (!rec) {
    rec = { emaBps: 0, lastBytes: uploaded, lastPerf: now, bytesUploaded: uploaded, bytesTotal: total };
    uploadSpeedState.files.set(file.id, rec);
  } else {
    if (uploaded < rec.lastBytes) {
      rec.lastBytes = uploaded;
      rec.lastPerf = now;
      rec.emaBps = 0;
    } else {
      const dt = (now - rec.lastPerf) / 1000;
      const dBytes = uploaded - rec.lastBytes;
      if (dt >= 0.18 && dBytes >= 0) {
        const inst = dBytes / dt;
        rec.emaBps = rec.emaBps > 0 ? rec.emaBps * 0.65 + inst * 0.35 : inst;
        rec.lastBytes = uploaded;
        rec.lastPerf = now;
      }
    }
    rec.bytesUploaded = uploaded;
    rec.bytesTotal = total;
  }
}

function updateBatchSpeedSample(totalUploadedBytes) {
  const now = performance.now();
  if (!uploadSpeedState.batchLastPerf || totalUploadedBytes < uploadSpeedState.batchLastBytes) {
    uploadSpeedState.batchLastPerf = now;
    uploadSpeedState.batchLastBytes = totalUploadedBytes;
    return;
  }
  const dt = (now - uploadSpeedState.batchLastPerf) / 1000;
  const dBytes = totalUploadedBytes - uploadSpeedState.batchLastBytes;
  if (dt >= 0.2 && dBytes >= 0) {
    const inst = dBytes / dt;
    uploadSpeedState.batchEmaBps =
      uploadSpeedState.batchEmaBps > 0 ? uploadSpeedState.batchEmaBps * 0.65 + inst * 0.35 : inst;
    uploadSpeedState.batchLastBytes = totalUploadedBytes;
    uploadSpeedState.batchLastPerf = now;
  }
}

function formatFileProgressText(f) {
  const size = f.size || 0;
  const rec = uploadSpeedState.files.get(f.id);
  const uploaded = rec ? rec.bytesUploaded : Number((f.progress && f.progress.bytesUploaded) || 0);
  const pct =
    f.progress && typeof f.progress.percentage === "number"
      ? Math.round(f.progress.percentage)
      : size > 0
      ? Math.min(100, Math.round((uploaded / size) * 100))
      : 0;
  const parts = [];
  if (uploaded > 0 && size > 0) {
    parts.push(`${fmt(Math.min(uploaded, size))} / ${fmt(size)}`);
  } else {
    parts.push(fmt(size));
  }
  parts.push(`${pct}%`);
  const bps = rec ? rec.emaBps : 0;
  if (bps > 1024) {
    parts.push(`${fmt(Math.round(bps))}/s`);
    const rem = Math.max(0, size - uploaded);
    const etaStr = fmtEta(rem / bps);
    if (etaStr) parts.push(etaStr);
  }
  return { text: parts.join(" · "), pct };
}

function getFileStatusKey(f) {
  const isDone = !!(f.progress && f.progress.uploadComplete);
  const isErr = !!f.error;
  const isRunning = !!(f.progress && f.progress.uploadStarted && !isDone && !isErr);
  if (isDone) return "done";
  if (isErr) return "err";
  if (isRunning) return "run";
  return "wait";
}

function renderQueue(uppy) {
  const files = uppy.getFiles();
  const dropEmpty = $("drop-empty");
  const dropQueue = $("drop-queue");
  const queueTitle = $("queue-title");
  const queueMeta = $("queue-meta");
  const overallWrap = $("overall-bar-wrap");
  const overallBar = $("overall-bar");
  const fileList = $("file-list");
  const btnPrimary = $("btn-primary-upload");
  const btnClear = $("btn-clear");
  const btnAddMore = $("btn-add-more");

  if (!files.length) {
    dropQueue.hidden = true;
    dropEmpty.hidden = false;
    overallWrap.hidden = true;
    overallBar.style.width = "0%";
    overallBar.classList.remove("is-done", "is-active");
    renderedRowCache.clear();
    renderedOrderSig = "";
    fileList.replaceChildren();
    return;
  }

  dropEmpty.hidden = true;
  dropQueue.hidden = false;

  const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
  const uploadedBytes = files.reduce((acc, f) => {
    if (f.error) return acc;
    if (f.progress && f.progress.uploadComplete) return acc + (f.size || 0);
    const rec = uploadSpeedState.files.get(f.id);
    if (rec) return acc + Math.min(f.size || 0, rec.bytesUploaded);
    return acc + Number((f.progress && f.progress.bytesUploaded) || 0);
  }, 0);
  const state = uppy.getState();
  const totalPct =
    totalBytes > 0
      ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))
      : Math.round(state.totalProgress || 0);
  const inProgress =
    batchUploading ||
    files.some(
      (f) => f.progress && f.progress.uploadStarted && !f.progress.uploadComplete && !f.error
    );
  const completedCount = files.filter((f) => f.progress && f.progress.uploadComplete).length;
  const failedCount = files.filter((f) => !!f.error).length;
  const pendingCount = files.filter(
    (f) => (!f.progress || !f.progress.uploadComplete) && !f.error
  ).length;
  const allComplete = completedCount === files.length;

  btnAddMore.hidden = inProgress;
  btnClear.hidden = inProgress;

  if (inProgress) {
    updateBatchSpeedSample(uploadedBytes);
    queueTitle.textContent = `正在上传 ${completedCount}/${files.length}`;
    const metaParts = [`${Math.max(1, totalPct)}%`, `${fmt(uploadedBytes)} / ${fmt(totalBytes)}`];
    if (uploadSpeedState.batchEmaBps > 1024) {
      metaParts.push(`${fmt(Math.round(uploadSpeedState.batchEmaBps))}/s`);
      const etaStr = fmtEta(Math.max(0, totalBytes - uploadedBytes) / uploadSpeedState.batchEmaBps);
      if (etaStr) metaParts.push(etaStr);
    }
    queueMeta.textContent = metaParts.join(" · ");
    overallWrap.hidden = false;
    overallBar.classList.remove("is-done");
    overallBar.classList.add("is-active");
    overallBar.style.width = `${Math.max(3, totalPct)}%`;
    btnPrimary.textContent = "取消上传";
    btnPrimary.className = "primary-upload-btn is-secondary";
    btnPrimary.dataset.mode = "cancel";
  } else if (allComplete) {
    queueTitle.textContent = `已完成 ${files.length} 个文件`;
    queueMeta.textContent = `${fmt(totalBytes)} · 已存入服务器`;
    overallWrap.hidden = false;
    overallBar.classList.remove("is-active");
    overallBar.classList.add("is-done");
    overallBar.style.width = "100%";
    btnPrimary.textContent = "上传完成 · 继续投递新文件";
    btnPrimary.className = "primary-upload-btn is-done";
    btnPrimary.dataset.mode = "reset";
  } else if (failedCount > 0 && pendingCount === 0) {
    queueTitle.textContent = `${failedCount} 个文件上传失败`;
    queueMeta.textContent = `成功 ${completedCount} / 共 ${files.length}`;
    overallWrap.hidden = true;
    overallBar.classList.remove("is-active", "is-done");
    btnPrimary.textContent = `重试失败文件 (${failedCount})`;
    btnPrimary.className = "primary-upload-btn";
    btnPrimary.dataset.mode = "retry";
  } else {
    queueTitle.textContent = `待上传 ${pendingCount} 个文件`;
    queueMeta.textContent = fmt(totalBytes);
    overallWrap.hidden = completedCount === 0;
    overallBar.classList.remove("is-active", "is-done");
    overallBar.style.width = `${totalPct}%`;
    btnPrimary.textContent = `开始上传 (${pendingCount} 个文件)`;
    btnPrimary.className = "primary-upload-btn";
    btnPrimary.dataset.mode = "upload";
  }

  // Fast path: update progress numbers & bar widths in-place without rebuilding DOM
  const nextOrderSig = files.map((f) => `${f.id}:${getFileStatusKey(f)}`).join("|");
  if (nextOrderSig === renderedOrderSig) {
    for (const f of files) {
      const cached = renderedRowCache.get(f.id);
      if (cached && cached.statusKey === "run") {
        const { text, pct } = formatFileProgressText(f);
        if (cached.txtEl) cached.txtEl.textContent = text;
        if (cached.fillEl) cached.fillEl.style.width = `${Math.max(4, pct)}%`;
      }
    }
    return;
  }

  // Structural/state change: rebuild rows cleanly and cache references
  renderedOrderSig = nextOrderSig;
  renderedRowCache.clear();
  const frag = document.createDocumentFragment();
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "file-row";

    const kind = classifyFile(f);
    const thumb = document.createElement("div");
    thumb.className = `file-thumb${kind.cls ? " " + kind.cls : ""}`;

    const imgUrl = kind.isImg ? getThumbUrl(f) : null;
    if (imgUrl) {
      const img = document.createElement("img");
      img.src = imgUrl;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      thumb.textContent = kind.label;
    }

    const main = document.createElement("div");
    main.className = "file-main";

    const nameEl = document.createElement("span");
    nameEl.className = "file-name";
    nameEl.textContent = f.name;
    main.appendChild(nameEl);

    const sub = document.createElement("div");
    const statusKey = getFileStatusKey(f);
    let txtEl = null;
    let fillEl = null;

    if (statusKey === "done") {
      sub.className = "file-sub is-ok";
      const meta = fileUploadMeta.get(f.id);
      const durS = meta && meta.durMs ? ` · ${(meta.durMs / 1000).toFixed(1)}s` : "";
      sub.textContent = `${fmt(f.size || 0)} · 已送达${durS}`;
    } else if (statusKey === "err") {
      sub.className = "file-sub is-err";
      sub.textContent = `${fmt(f.size || 0)} · 传输中断，可点击右侧重试`;
    } else if (statusKey === "run") {
      sub.className = "file-sub";
      const { text, pct } = formatFileProgressText(f);
      txtEl = document.createElement("span");
      txtEl.textContent = text;
      const trackBar = document.createElement("span");
      trackBar.className = "mini-track";
      fillEl = document.createElement("span");
      fillEl.className = "mini-fill";
      fillEl.style.width = `${Math.max(4, pct)}%`;
      trackBar.appendChild(fillEl);
      sub.append(txtEl, trackBar);
    } else {
      sub.className = "file-sub";
      sub.textContent = `${fmt(f.size || 0)} · 等待上传`;
    }
    main.appendChild(sub);

    li.append(thumb, main);

    if (statusKey === "done") {
      const okBadge = document.createElement("span");
      okBadge.className = "file-badge-ok";
      okBadge.setAttribute("aria-label", "已上传");
      okBadge.appendChild(svgIcon("M16.2 5.8 8.2 13.8l-4-4", 14, 2.3));
      li.appendChild(okBadge);
    } else if (statusKey === "err") {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "file-act";
      retryBtn.title = "重试";
      retryBtn.setAttribute("aria-label", `重试 ${f.name}`);
      retryBtn.appendChild(svgIcon("M3.5 10a6.5 6.5 0 0 1 11.2-4.5M15 2.8v3.2h-3.2M16.5 10a6.5 6.5 0 0 1-11.2 4.5M5 17.2V14h3.2", 15, 1.9));
      retryBtn.addEventListener("click", () => {
        acquireWake();
        uploadSpeedState.files.delete(f.id);
        fileUploadMeta.delete(f.id);
        const p = uppy.retryUpload(f.id);
        renderQueue(uppy);
        if (p && typeof p.then === "function") {
          p.then((res) => {
            if (res && Array.isArray(res.successful) && res.successful.length > 0) {
              setTimeout(() => refreshStatsInPlace(), 2600);
            }
          })
            .catch(() => {})
            .finally(() => {
              const stillRunning = uppy
                .getFiles()
                .some(
                  (item) =>
                    item.progress &&
                    item.progress.uploadStarted &&
                    !item.progress.uploadComplete &&
                    !item.error
                );
              if (!stillRunning) {
                batchUploading = false;
                releaseWake();
              }
              renderQueue(uppy);
            });
        }
      });
      li.appendChild(retryBtn);
    }

    if (statusKey !== "run") {
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "file-act";
      rmBtn.title = "移除";
      rmBtn.setAttribute("aria-label", `移除 ${f.name}`);
      rmBtn.appendChild(svgIcon("M5.5 5.5l9 9M14.5 5.5l-9 9", 14, 1.9));
      rmBtn.addEventListener("click", () => uppy.removeFile(f.id));
      li.appendChild(rmBtn);
    }

    renderedRowCache.set(f.id, { li, statusKey, txtEl, fillEl });
    frag.appendChild(li);
  }
  fileList.replaceChildren(frag);
}

function addNativeFilesToUppy(uppy, fileListLike) {
  if (!fileListLike || !fileListLike.length) return;
  const descriptors = [];
  for (const rawFile of Array.from(fileListLike)) {
    descriptors.push({
      name: rawFile.name,
      type: rawFile.type || "application/octet-stream",
      data: rawFile,
      source: "Local",
      isRemote: false,
    });
  }
  try {
    uppy.addFiles(descriptors);
  } catch (_) {}
}

function initUppy() {
  if (uppyInstance) return;

  const uppy = new Uppy({
    locale: zh_CN,
    autoProceed: false,
    restrictions: {
      maxFileSize: MAX_FILE_BYTES,
    },
  });

  uppy.use(XHRUpload, {
    endpoint: (file) => buildUploadEndpoint(Array.isArray(file) ? file[0] : file),
    method: "PUT",
    formData: false,
    bundle: false,
    limit: 3,
    timeout: 180 * 1000,
    withCredentials: true,
    shouldRetry: (xhr) => xhr.status === 0 || xhr.status === 429 || xhr.status >= 502,
    getResponseData: () => ({}),
  });

  let pendingAdded = [];
  let addTimer = null;
  let batchStartPerf = 0;

  uppy.on("restriction-failed", (file, error) => {
    const fname = file && file.name ? `「${file.name}」` : "所选文件";
    if (file && file.size > MAX_FILE_BYTES) {
      showToast(`${fname} 超过单文件 1 GB 上限`);
    } else {
      showToast((error && error.message) || `${fname} 无法添加`);
    }
  });

  uppy.on("file-added", (file) => {
    renderQueue(uppy);
    pendingAdded.push({
      name: file.name,
      size: file.size || 0,
      type: file.type || null,
      last_modified:
        file.data && file.data.lastModified ? new Date(file.data.lastModified).toISOString() : null,
    });
    if (addTimer) clearTimeout(addTimer);
    addTimer = setTimeout(() => {
      const batch = pendingAdded.splice(0, pendingAdded.length);
      const all = uppy.getFiles();
      track("files_added", {
        added_count: batch.length,
        queue_count: all.length,
        queue_bytes: all.reduce((s, f) => s + (f.size || 0), 0),
        files: batch.slice(0, 30),
        files_truncated: Math.max(0, batch.length - 30),
      });
    }, 80);
  });

  uppy.on("file-removed", (file) => {
    if (file && file.id) {
      revokeThumb(file.id);
      uploadSpeedState.files.delete(file.id);
      fileUploadMeta.delete(file.id);
    }
    renderQueue(uppy);
    track("file_removed", {
      name: file ? file.name : null,
      size: file ? file.size || 0 : 0,
      remaining_count: uppy.getFiles().length,
    });
  });

  uppy.on("cancel-all", () => {
    batchUploading = false;
    for (const k of Array.from(thumbUrls.keys())) revokeThumb(k);
    fileUploadMeta.clear();
    resetUploadSpeedState();
    releaseWake();
    renderQueue(uppy);
    track("upload_cancel", {});
  });

  uppy.on("upload", (_uploadId, startingFiles) => {
    const allFiles = uppy.getFiles();
    const startingIds = new Set(Array.isArray(startingFiles) ? startingFiles.map((f) => f.id) : []);
    const othersRunning = allFiles.some(
      (f) =>
        !startingIds.has(f.id) &&
        f.progress &&
        f.progress.uploadStarted &&
        !f.progress.uploadComplete &&
        !f.error
    );
    if (!othersRunning) {
      batchStartPerf = performance.now();
      resetUploadSpeedState();
    } else {
      for (const id of startingIds) {
        uploadSpeedState.files.delete(id);
      }
    }
    acquireWake();
    renderQueue(uppy);
    const fileItems = allFiles.map((f) => ({ name: f.name, size: f.size || 0, type: f.type || null }));
    track("upload_start", {
      batch_count: allFiles.length,
      total_bytes: allFiles.reduce((s, f) => s + (f.size || 0), 0),
      files: fileItems.slice(0, 30),
      files_truncated: Math.max(0, fileItems.length - 30),
    });
  });

  uppy.on("upload-start", () => renderQueue(uppy));

  uppy.on("upload-progress", (file, progress) => {
    recordFileUploadProgress(file, progress);
    renderQueue(uppy);
  });
  uppy.on("progress", () => renderQueue(uppy));

  uppy.on("upload-success", (file) => {
    if (file) {
      const meta = fileUploadMeta.get(file.id);
      const durMs = meta ? Math.max(1, Math.round(performance.now() - meta.startPerf)) : null;
      if (meta && durMs) meta.durMs = durMs;
      uploadSpeedState.files.delete(file.id);
      renderQueue(uppy);
      const mbps =
        durMs && file.size
          ? Math.round(((file.size / 1048576) / (durMs / 1000)) * 100) / 100
          : null;
      track("file_uploaded", {
        name: file.name,
        saved_as: meta ? meta.savedName : null,
        size: file.size || 0,
        type: file.type || null,
        duration_ms: durMs,
        speed_mb_s: mbps,
      });
    } else {
      renderQueue(uppy);
    }
  });

  uppy.on("upload-error", (file, error, response) => {
    if (file && file.id) {
      uploadSpeedState.files.delete(file.id);
      fileUploadMeta.delete(file.id);
    }
    renderQueue(uppy);
    const status = (response && response.status) || (error && error.source && error.source.status) || 0;
    track("upload_error", {
      name: file ? file.name : null,
      size: file ? file.size || 0 : 0,
      status: status || undefined,
      error: error ? String(error.message || error) : "unknown",
    });
    if (status === 401) {
      showToast("口令会话已过期，请重新输入口令");
      if (typeof handleSessionExpired === "function") {
        handleSessionExpired("口令会话已过期，请重新输入口令");
      }
    }
  });

  uppy.on("error", () => {
    batchUploading = false;
    releaseWake();
    renderQueue(uppy);
  });

  uppy.on("complete", (result) => {
    batchUploading = false;
    releaseWake();
    renderQueue(uppy);
    const ok = (result.successful || []).length;
    const fail = (result.failed || []).length;
    const okBytes = (result.successful || []).reduce((s, f) => s + (f.size || 0), 0);
    if (ok > 0) {
      setTimeout(() => refreshStatsInPlace(), 2600);
    }
    track("upload_complete", {
      ok_count: ok,
      fail_count: fail,
      ok_bytes: okBytes,
      elapsed_ms: batchStartPerf ? Math.round(performance.now() - batchStartPerf) : null,
    });
  });

  // Wire UI interactions
  const picker = $("file-picker");
  const dropEmpty = $("drop-empty");
  const btnAddMore = $("btn-add-more");
  const btnClear = $("btn-clear");
  const btnPrimary = $("btn-primary-upload");
  const dragVeil = $("drag-veil");
  const viewWs = $("view-ws");

  const openPicker = () => {
    track("picker_open", { queue_count: uppy.getFiles().length });
    picker.click();
  };

  dropEmpty.addEventListener("click", openPicker);
  dropEmpty.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  });

  btnAddMore.addEventListener("click", openPicker);

  picker.addEventListener("change", () => {
    if (picker.files && picker.files.length) {
      addNativeFilesToUppy(uppy, picker.files);
      picker.value = "";
    }
  });

  picker.addEventListener("cancel", () => {
    track("picker_cancel", { queue_count: uppy.getFiles().length });
  });

  btnClear.addEventListener("click", () => {
    batchUploading = false;
    uppy.cancelAll();
    for (const k of Array.from(thumbUrls.keys())) revokeThumb(k);
    fileUploadMeta.clear();
    resetUploadSpeedState();
    uppy.clear();
    renderQueue(uppy);
  });

  btnPrimary.addEventListener("click", () => {
    const mode = btnPrimary.dataset.mode;
    if (mode === "cancel") {
      batchUploading = false;
      uppy.cancelAll();
    } else if (mode === "retry") {
      if (batchUploading) return;
      batchUploading = true;
      renderQueue(uppy);
      uppy.retryAll().catch(() => {}).finally(() => {
        const stillRunning = uppy
          .getFiles()
          .some((f) => f.progress && f.progress.uploadStarted && !f.progress.uploadComplete && !f.error);
        if (!stillRunning) {
          batchUploading = false;
          releaseWake();
        }
        renderQueue(uppy);
      });
    } else if (mode === "reset") {
      batchUploading = false;
      for (const k of Array.from(thumbUrls.keys())) revokeThumb(k);
      fileUploadMeta.clear();
      resetUploadSpeedState();
      uppy.clear();
      renderQueue(uppy);
      openPicker();
    } else {
      if (batchUploading) return;
      batchUploading = true;
      renderQueue(uppy);
      uppy.upload().catch(() => {}).finally(() => {
        const stillRunning = uppy
          .getFiles()
          .some((f) => f.progress && f.progress.uploadStarted && !f.progress.uploadComplete && !f.error);
        if (!stillRunning) {
          batchUploading = false;
          releaseWake();
        }
        renderQueue(uppy);
      });
    }
  });

  // Full-window drag & drop when workspace is unlocked and PDF modal is closed
  let dragDepth = 0;
  const resetDragVeil = () => {
    dragDepth = 0;
    dragVeil.hidden = true;
  };
  const canAcceptDrop = () => {
    if (viewWs.hidden) return false;
    const pdfModal = $("pdf-modal");
    if (pdfModal && !pdfModal.hidden) return false;
    return true;
  };

  window.addEventListener("dragenter", (e) => {
    if (!canAcceptDrop()) return;
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      dragDepth += 1;
      dragVeil.hidden = false;
    }
  });

  window.addEventListener("dragover", (e) => {
    if (!canAcceptDrop()) return;
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });

  window.addEventListener("dragleave", () => {
    if (viewWs.hidden) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dragVeil.hidden = true;
    }
  });

  window.addEventListener("drop", (e) => {
    if (!canAcceptDrop()) {
      resetDragVeil();
      return;
    }
    e.preventDefault();
    resetDragVeil();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addNativeFilesToUppy(uppy, e.dataTransfer.files);
    }
  });

  window.addEventListener("dragend", resetDragVeil);
  window.addEventListener("blur", resetDragVeil);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dragVeil.hidden) resetDragVeil();
  });
  dragVeil.addEventListener("click", resetDragVeil);

  uppyInstance = uppy;
  renderQueue(uppy);
}

/* =========================================================
   DYNAMIC DELIVERY & HISTORY CENTER (manifest.json + stats.json)
   ========================================================= */
let manifestData = null;
let downloadCounts = {};
let inboxReceipts = [];
let activeTab = "all";
let searchQuery = "";
let deliveryWired = false;
let authEpoch = 0;
let manifestAbort = null;
let statsAbort = null;
const badgeNodes = new Map();
const batchSumNodes = new Map();

function appendBreakableFilename(el, text) {
  const parts = String(text || "").split(/([_-])/);
  for (const part of parts) {
    if (!part) continue;
    el.appendChild(document.createTextNode(part));
    if (part === "_" || part === "-") {
      el.appendChild(document.createElement("wbr"));
    }
  }
}

function readDownloadCounts(stats) {
  const counts = stats?.downloads;
  return counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {};
}

function updateBadgeDisplay(el, count, animate = false) {
  if (!el) return;
  el.textContent = `已下载 ${count} 次`;
  el.classList.toggle("has-hits", count > 0);
  if (animate) {
    el.classList.remove("is-bump");
    void el.offsetWidth;
    el.classList.add("is-bump");
  }
}

function updateBatchSum(batchId, animate = false) {
  const entry = batchSumNodes.get(batchId);
  if (!entry) return;
  const total = entry.paths.reduce((acc, p) => acc + Number(downloadCounts[p] || 0), 0);
  entry.el.textContent = `共下载 ${total} 次`;
  entry.el.classList.toggle("has-hits", total > 0);
  if (animate) {
    entry.el.classList.remove("is-bump");
    void entry.el.offsetWidth;
    entry.el.classList.add("is-bump");
  }
}

function renderReceipts() {
  const root = $("receipt-root");
  if (!root) return;
  if (!inboxReceipts || !inboxReceipts.length) {
    root.hidden = true;
    root.replaceChildren();
    return;
  }

  const existingDetails = root.querySelector("details.receipt-drawer");
  const prevOpen = existingDetails ? existingDetails.open : null;
  const pendingCnt = inboxReceipts.filter((r) => r.status === "pending").length;
  const archivedCnt = inboxReceipts.length - pendingCnt;

  const details = document.createElement("details");
  details.className = "receipt-drawer";
  details.open = prevOpen !== null ? prevOpen : pendingCnt > 0;

  const summary = document.createElement("summary");
  summary.className = "receipt-head";
  summary.addEventListener("click", () => {
    track("receipt_toggle", { open: !details.open, count: inboxReceipts.length });
  });

  const left = document.createElement("span");
  left.className = "receipt-head-left";

  const badge = document.createElement("span");
  badge.className = pendingCnt > 0 ? "receipt-badge has-pending" : "receipt-badge";
  badge.textContent = "收件回执";
  left.appendChild(badge);

  const label = document.createElement("span");
  if (pendingCnt > 0 && archivedCnt > 0) {
    label.textContent = `${pendingCnt} 份新投递待处理 · 另有 ${archivedCnt} 份已归档`;
  } else if (pendingCnt > 0) {
    label.textContent = `${pendingCnt} 份新投递已收妥，待处理（只读）`;
  } else {
    label.textContent = `已收妥 ${archivedCnt} 份历史原件（只读）`;
  }
  left.appendChild(label);

  const chev = makeInlineSvg([{ d: "m4 6 4 4 4-4" }], "0 0 16 16", 15, 2);
  chev.classList.add("receipt-chev");
  summary.append(left, chev);
  details.appendChild(summary);

  const ul = document.createElement("ul");
  ul.className = "receipt-list";
  for (const r of inboxReceipts) {
    const li = document.createElement("li");
    li.className = "receipt-item";

    const nameEl = document.createElement("span");
    nameEl.className = "receipt-name";
    appendBreakableFilename(nameEl, r.name);

    const right = document.createElement("span");
    right.className = "receipt-right";

    const meta = document.createElement("span");
    meta.textContent = `${r.ts} · ${fmt(r.bytes || 0)}`;

    const tag = document.createElement("span");
    const isPend = r.status === "pending";
    tag.className = `receipt-tag ${isPend ? "is-pending" : "is-archived"}`;
    tag.textContent = isPend ? "待处理" : "已归档";

    right.append(meta, tag);
    li.append(nameEl, right);
    ul.appendChild(li);
  }
  details.appendChild(ul);

  root.replaceChildren(details);
  root.hidden = false;
}

async function refreshStatsInPlace() {
  if (!manifestData) return;
  const myEpoch = authEpoch;
  if (statsAbort) {
    try {
      statsAbort.abort();
    } catch (_) {}
  }
  const ctrl = new AbortController();
  statsAbort = ctrl;
  try {
    const res = await fetch(`/u/stats.json?_=${Date.now()}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (myEpoch !== authEpoch) return;
    if (res.status === 401 || res.status === 403) {
      if (typeof handleSessionExpired === "function") {
        handleSessionExpired("口令会话已过期，请重新输入口令");
      }
      return;
    }
    if (!res.ok) return;
    const statsJson = await res.json();
    if (myEpoch !== authEpoch || !manifestData) return;
    const nextCounts = readDownloadCounts(statsJson);
    const previousCounts = downloadCounts;
    downloadCounts = nextCounts;
    let anyChanged = false;
    for (const path of badgeNodes.keys()) {
      const prevVal = Number(previousCounts[path] || 0);
      const nextVal = Number(nextCounts[path] || 0);
      if (nextVal !== prevVal) {
        anyChanged = true;
        updateBadgeDisplay(badgeNodes.get(path), nextVal, nextVal > prevVal);
      }
    }
    if (anyChanged) {
      for (const bid of batchSumNodes.keys()) {
        updateBatchSum(bid, true);
      }
    }
    if (Array.isArray(statsJson.receipts)) {
      const prevSig = JSON.stringify(inboxReceipts);
      const nextSig = JSON.stringify(statsJson.receipts);
      if (prevSig !== nextSig) {
        inboxReceipts = statsJson.receipts;
        renderReceipts();
      }
    }
  } catch (_) {} finally {
    if (statsAbort === ctrl) statsAbort = null;
  }
}

function encodePathSegments(relPath) {
  return String(relPath || "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function makeInlineSvg(paths, viewBox = "0 0 16 16", size = 13, strokeWidth = 1.9) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const spec of paths) {
    const el = document.createElementNS(ns, spec.tag || "path");
    for (const [k, v] of Object.entries(spec)) {
      if (k === "tag") continue;
      el.setAttribute(k, String(v));
    }
    svg.appendChild(el);
  }
  return svg;
}

function buildDeliveryRow(item, batchId) {
  const row = document.createElement("div");
  row.className = "delivery-row";

  const ext = (item.ext || "PDF").toUpperCase();
  const icon = document.createElement("div");
  icon.className = ext === "ZIP" ? "att-icon att-icon-ref" : "att-icon";
  icon.setAttribute("aria-hidden", "true");
  const extEl = document.createElement("span");
  extEl.className = "att-ext";
  extEl.textContent = ext.slice(0, 4);
  icon.appendChild(extEl);

  const body = document.createElement("div");
  body.className = "att-body";

  const nameEl = document.createElement("span");
  nameEl.className = "att-name";
  appendBreakableFilename(nameEl, item.name);
  body.appendChild(nameEl);

  const metaParts = [];
  if (item.lang) metaParts.push(item.lang);
  if (item.desc) metaParts.push(item.desc);
  if (typeof item.pages === "number" && item.pages > 0) metaParts.push(`${item.pages} 页`);
  if (typeof item.bytes === "number" && item.bytes > 0) metaParts.push(fmt(item.bytes));

  const metaEl = document.createElement("span");
  metaEl.className = "att-meta";
  metaEl.textContent = metaParts.join(" · ");

  const cnt = Number(downloadCounts[item.path] || 0);
  const countEl = document.createElement("span");
  countEl.className = cnt > 0 ? "att-count has-hits" : "att-count";
  countEl.textContent = `已下载 ${cnt} 次`;
  badgeNodes.set(item.path, countEl);
  metaEl.appendChild(countEl);
  body.appendChild(metaEl);

  const actions = document.createElement("div");
  actions.className = "delivery-actions";

  const encoded = encodePathSegments(item.path);
  const dlHref = `/u/files/${encoded}`;
  const viewHref = `/u/view/${encoded}`;

  if (item.preview) {
    const pv = document.createElement("a");
    pv.className = "att-btn att-btn-preview";
    pv.href = viewHref;
    pv.target = "_blank";
    pv.rel = "noopener noreferrer";
    pv.setAttribute("aria-label", `预览 ${item.name}`);
    pv.appendChild(
      makeInlineSvg([
        { d: "M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8Z" },
        { tag: "circle", cx: "8", cy: "8", r: "1.9" },
      ])
    );
    const pvTxt = document.createElement("span");
    pvTxt.textContent = "预览";
    pv.appendChild(pvTxt);
    pv.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) {
        track("file_preview", {
          batch_id: batchId,
          filename: item.name,
          href: viewHref,
          mode: "native_tab",
        });
        return;
      }
      e.preventDefault();
      track("file_preview", {
        batch_id: batchId,
        filename: item.name,
        href: viewHref,
        mode: "in_page_reader",
      });
      openPdfReader(item, batchId, viewHref, dlHref, pv);
    });
    actions.appendChild(pv);
  }

  const dl = document.createElement("a");
  dl.className = "att-btn att-btn-dl";
  dl.href = dlHref;
  dl.setAttribute("download", item.name);
  dl.setAttribute("aria-label", `下载 ${item.name}`);
  dl.append(makeInlineSvg([{ d: "M8 2.5v8M4.8 7.5l3.2 3.3 3.2-3.3M3 13.5h10" }]));
  const dlText = document.createElement("span");
  dlText.textContent = "下载";
  dl.append(dlText);
  dl.addEventListener("click", () => {
    setTimeout(refreshStatsInPlace, 3200);
    track("file_download", {
      batch_id: batchId,
      filename: item.name,
      href: dlHref,
    });
  });
  actions.appendChild(dl);

  row.append(icon, body, actions);
  return row;
}

function updateTabCounts() {
  const tabsEl = $("delivery-tabs");
  if (!tabsEl || !manifestData) return;
  const batches = manifestData.batches || [];
  const latestCount = batches.filter((b) => b.status === "latest").length;
  const archiveCount = batches.filter((b) => b.status !== "latest").length;
  const refCount = (manifestData.references || []).length;

  tabsEl.querySelectorAll(".tray-tab").forEach((btn) => {
    const tab = btn.dataset.tab;
    btn.classList.toggle("is-active", tab === activeTab);
    btn.setAttribute("aria-pressed", String(tab === activeTab));
    if (tab === "all") btn.textContent = "全部";
    else if (tab === "latest") btn.textContent = latestCount > 1 ? `最新交付 (${latestCount})` : "最新交付";
    else if (tab === "archive") btn.textContent = archiveCount ? `历史归档 (${archiveCount})` : "历史归档";
    else if (tab === "reference") btn.textContent = refCount ? `参考资料 (${refCount})` : "参考资料";
  });
}

function matchesSearch(q, ...fields) {
  if (!q) return true;
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

function renderDeliveries() {
  const root = $("delivery-root");
  if (!root) return;
  badgeNodes.clear();
  batchSumNodes.clear();
  updateTabCounts();

  if (!manifestData) {
    root.replaceChildren();
    const p = document.createElement("p");
    p.className = "delivery-state";
    p.textContent = "正在加载交付记录…";
    root.appendChild(p);
    return;
  }

  const q = searchQuery.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let renderedCount = 0;

  const showBatches = activeTab === "all" || activeTab === "latest" || activeTab === "archive";
  const showRefs = activeTab === "all" || activeTab === "reference";

  if (showBatches) {
    const batches = (manifestData.batches || []).filter((b) => {
      if (activeTab === "latest") return b.status === "latest";
      if (activeTab === "archive") return b.status !== "latest";
      return true;
    });

    for (const batch of batches) {
      const batchMatches = matchesSearch(q, batch.title, batch.date, batch.lang_badge, batch.summary, batch.id);
      const files = (batch.files || []).filter(
        (f) => batchMatches || matchesSearch(q, f.name, f.desc, f.lang, f.ext)
      );
      if (!files.length) continue;

      const isLatest = batch.status === "latest";
      const details = document.createElement("details");
      details.className = "batch-card";
      if (isLatest || !!q || activeTab === "archive") {
        details.open = true;
      }

      const summary = document.createElement("summary");
      summary.className = "batch-head";
      summary.addEventListener("click", () => {
        track("batch_toggle", {
          batch_id: batch.id,
          title: batch.title,
          open: !details.open,
        });
      });

      const headMain = document.createElement("div");
      headMain.className = "batch-head-main";

      const topLine = document.createElement("div");
      topLine.className = "batch-top-line";

      const statusPill = document.createElement("span");
      statusPill.className = `batch-pill ${isLatest ? "is-latest" : "is-archive"}`;
      statusPill.textContent = isLatest ? "最新交付" : "历史归档";
      topLine.appendChild(statusPill);

      if (batch.lang_badge) {
        const langPill = document.createElement("span");
        langPill.className = "batch-pill is-lang";
        langPill.textContent = batch.lang_badge;
        topLine.appendChild(langPill);
      }

      if (batch.date) {
        const dateEl = document.createElement("span");
        dateEl.className = "batch-date";
        dateEl.textContent = batch.date;
        topLine.appendChild(dateEl);
      }

      const allBatchPaths = (batch.files || []).map((f) => f.path);
      const batchTotalDl = allBatchPaths.reduce((acc, p) => acc + Number(downloadCounts[p] || 0), 0);
      const sumPill = document.createElement("span");
      sumPill.className = batchTotalDl > 0 ? "batch-pill is-dl-sum has-hits" : "batch-pill is-dl-sum";
      sumPill.textContent = `共下载 ${batchTotalDl} 次`;
      batchSumNodes.set(batch.id, { el: sumPill, paths: allBatchPaths });
      topLine.appendChild(sumPill);

      const titleEl = document.createElement("span");
      titleEl.className = "batch-title";
      titleEl.textContent = batch.title;

      const sumEl = document.createElement("span");
      sumEl.className = "batch-summary";
      sumEl.textContent = batch.summary || `${files.length} 个文件`;

      headMain.append(topLine, titleEl, sumEl);

      const chev = makeInlineSvg([{ d: "m4 6 4 4 4-4" }], "0 0 16 16", 16, 2);
      chev.classList.add("batch-chev");

      summary.append(headMain, chev);
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "batch-body";
      for (const f of files) {
        body.appendChild(buildDeliveryRow(f, batch.id));
      }
      details.appendChild(body);

      frag.appendChild(details);
      renderedCount += files.length;
    }
  }

  if (showRefs) {
    const refs = (manifestData.references || []).filter((r) =>
      matchesSearch(q, r.name, r.desc, r.lang, r.ext, "参考资料")
    );
    if (refs.length) {
      const sec = document.createElement("div");
      sec.className = "ref-section";

      const div = document.createElement("div");
      div.className = "tray-divider";
      const label = document.createElement("span");
      label.textContent = "参考资料档案库";
      div.appendChild(label);
      sec.appendChild(div);

      for (const r of refs) {
        sec.appendChild(buildDeliveryRow(r, "reference"));
        renderedCount += 1;
      }
      frag.appendChild(sec);
    }
  }

  root.replaceChildren();
  lastRenderedCount = renderedCount;
  if (renderedCount === 0) {
    const empty = document.createElement("p");
    empty.className = "delivery-state";
    empty.textContent = q ? `未找到匹配「${searchQuery.trim()}」的文件` : "当前分类暂无文件";
    root.appendChild(empty);
  } else {
    root.appendChild(frag);
  }
}

let lastRenderedCount = 0;
let searchTrackTimer = null;
let lastTrackedQuery = "";

function wireDeliveryControls() {
  if (deliveryWired) return;
  deliveryWired = true;

  const tabsEl = $("delivery-tabs");
  const searchEl = $("delivery-search");

  if (tabsEl) {
    tabsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".tray-tab");
      if (!btn || !btn.dataset.tab) return;
      const nextTab = btn.dataset.tab;
      if (nextTab !== activeTab) {
        activeTab = nextTab;
        renderDeliveries();
        track("tab_switch", { tab: activeTab, results: lastRenderedCount });
      }
    });
  }

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      searchQuery = searchEl.value || "";
      renderDeliveries();
      if (searchTrackTimer) clearTimeout(searchTrackTimer);
      searchTrackTimer = setTimeout(() => {
        const trimmed = searchQuery.trim().slice(0, 80);
        if (trimmed !== lastTrackedQuery) {
          lastTrackedQuery = trimmed;
          track("search_query", { q: trimmed, results: lastRenderedCount });
        }
      }, 700);
    });
  }
}

/* =========================================================
   SELF-HOSTED IN-PAGE PDF.JS READER + DOCSEND PAGE ANALYTICS
   ========================================================= */
let pdfjsLibPromise = null;
let pdfjsLibLoaded = null;
let pdfSession = null;
let pdfModalWired = false;
let pdfFindTimer = null;

function getPdfJsLib() {
  if (!pdfjsLibPromise) {
    const modUrl = "/u/pdfjs/pdf.min.mjs";
    pdfjsLibPromise = import(modUrl)
      .then((lib) => {
        if (lib && lib.GlobalWorkerOptions) {
          lib.GlobalWorkerOptions.workerSrc = "/u/pdfjs/pdf.worker.min.mjs";
        }
        pdfjsLibLoaded = lib;
        return lib;
      })
      .catch((err) => {
        pdfjsLibPromise = null;
        throw err;
      });
  }
  return pdfjsLibPromise;
}

function commitCurrentPdfPageDwell() {
  if (!pdfSession || !pdfSession.activePage || !pdfSession.pageEnterPerf) return;
  const now = performance.now();
  const delta = Math.max(0, Math.round(now - pdfSession.pageEnterPerf));
  const p = pdfSession.activePage;
  pdfSession.pageDwellMs[p] = (pdfSession.pageDwellMs[p] || 0) + delta;
  pdfSession.pageEnterPerf = now;
}

function checkPdfMilestones() {
  if (!pdfSession || !pdfSession.totalPages) return;
  const pct = Math.round((pdfSession.pagesViewed.size / pdfSession.totalPages) * 100);
  for (const m of [25, 50, 75, 100]) {
    if (pct >= m && !pdfSession.milestonesSent.has(m)) {
      pdfSession.milestonesSent.add(m);
      track("pdf_page_milestone", {
        batch_id: pdfSession.batchId,
        filename: pdfSession.filename,
        milestone_pct: m,
        pages_viewed: pdfSession.pagesViewed.size,
        total_pages: pdfSession.totalPages,
        current_page: pdfSession.activePage,
      });
    }
  }
}

function buildPdfSummary(reason) {
  commitCurrentPdfPageDwell();
  const pageDwellSec = {};
  let totalReadMs = 0;
  for (const [k, ms] of Object.entries(pdfSession.pageDwellMs)) {
    const s = Math.round(ms / 100) / 10;
    if (s > 0) pageDwellSec[k] = s;
    totalReadMs += ms;
  }
  const totalPages = pdfSession.totalPages || 0;
  const viewedCount = pdfSession.pagesViewed.size;
  const completionPct = totalPages ? Math.round((viewedCount / totalPages) * 100) : 0;
  return {
    batch_id: pdfSession.batchId,
    filename: pdfSession.filename,
    reason,
    total_pages: totalPages,
    pages_viewed: viewedCount,
    max_page: pdfSession.maxPage,
    completion_pct: completionPct,
    read_ms: totalReadMs,
    wall_ms: Math.round(performance.now() - pdfSession.openPerf),
    zoom_pct: Math.round((pdfSession.zoom || 1) * 100),
    page_dwell_s: pageDwellSec,
  };
}

function flushPdfTelemetry(reason, useBeacon = false) {
  if (!pdfSession || pdfSession.flushedClose || !pdfSession.totalPages) return;
  const summary = buildPdfSummary(reason);
  if (reason === "close" || reason === "pagehide") {
    pdfSession.flushedClose = true;
  } else {
    // Pause timer while hidden
    pdfSession.pageEnterPerf = null;
  }
  const evName = reason === "visibility_hidden" ? "pdf_view_pause" : "pdf_view_close";
  if (useBeacon && navigator.sendBeacon) {
    const payloadStr = JSON.stringify({
      vid: VID,
      sid: SID,
      seq: ++eventSeq,
      event: evName,
      client_ts: new Date().toISOString(),
      dwell_ms: Math.round(performance.now() - PAGE_ENTER_PERF),
      detail: summary,
    });
    const ep = `/u/track?ev=${encodeURIComponent(evName)}&vid=${encodeURIComponent(VID)}&sid=${encodeURIComponent(SID)}`;
    try {
      navigator.sendBeacon(ep, new Blob([payloadStr], { type: "application/json" }));
      return;
    } catch (_) {}
  }
  track(evName, summary, useBeacon);
}

function resumePdfTimer() {
  if (pdfSession && !pdfSession.flushedClose) {
    pdfSession.pageEnterPerf = performance.now();
  }
}

function cleanupPdfObservers() {
  if (!pdfSession) return;
  if (pdfSession.renderObs) pdfSession.renderObs.disconnect();
  if (pdfSession.viewObs) pdfSession.viewObs.disconnect();
  if (pdfSession.resizeObs) pdfSession.resizeObs.disconnect();
  if (pdfSession.resizeTimer) {
    clearTimeout(pdfSession.resizeTimer);
    pdfSession.resizeTimer = null;
  }
  if (pdfSession.renderTasks) {
    for (const entry of pdfSession.renderTasks.values()) {
      try {
        if (entry && entry.renderTask) entry.renderTask.cancel();
      } catch (_) {}
      try {
        if (entry && entry.textLayerTask) entry.textLayerTask.cancel();
      } catch (_) {}
    }
    pdfSession.renderTasks.clear();
  }
  if (pdfSession.loadingTask) {
    try {
      pdfSession.loadingTask.destroy();
    } catch (_) {}
    pdfSession.loadingTask = null;
  }
  if (pdfSession.pdfDoc) {
    try {
      pdfSession.pdfDoc.destroy();
    } catch (_) {}
    pdfSession.pdfDoc = null;
  }
  try {
    if (pdfjsLibLoaded && pdfjsLibLoaded.TextLayer && typeof pdfjsLibLoaded.TextLayer.cleanup === "function") {
      pdfjsLibLoaded.TextLayer.cleanup();
    }
  } catch (_) {}
}

function closePdfReader(reason = "close") {
  if (pdfFindTimer) {
    clearTimeout(pdfFindTimer);
    pdfFindTimer = null;
  }
  const modal = $("pdf-modal");
  const findBar = $("pdf-find-bar");
  const findBtn = $("pdf-find-toggle");
  const findInput = $("pdf-find-input");
  const findCount = $("pdf-find-count");
  const trigger = pdfSession?.trigger;
  if (pdfSession) {
    flushPdfTelemetry(reason, false);
    cleanupPdfObservers();
    pdfSession = null;
  }
  if (findBar) findBar.hidden = true;
  if (findBtn) findBtn.classList.remove("is-active");
  if (findInput) findInput.value = "";
  if (findCount) {
    findCount.textContent = "";
    findCount.classList.remove("is-empty");
  }
  if (modal) modal.hidden = true;
  const pagesEl = $("pdf-pages");
  if (pagesEl) {
    for (const c of pagesEl.querySelectorAll("canvas")) {
      c.width = 0;
      c.height = 0;
    }
    pagesEl.replaceChildren();
  }
  document.body.style.overflow = "";
  document.querySelector(".viewport-shell").inert = false;
  if (reason !== "lock" && reason !== "auth_expired" && reason !== "retry") trigger?.focus();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function needsLineBreakSpace(prev, next) {
  return /[A-Za-z0-9,.;:?!)\]}'"%]$/.test(prev) && /^[A-Za-z0-9(\[{'"$]/.test(next);
}

function buildPageSearchText(items) {
  let full = "";
  let sawEol = false;
  for (const it of items || []) {
    if (!it || typeof it.str !== "string") continue;
    const s = it.str;
    if (s.length > 0) {
      if (full.length > 0 && sawEol && needsLineBreakSpace(full, s)) {
        full += " ";
      }
      full += s;
      sawEol = false;
    }
    if (it.hasEOL) sawEol = true;
  }
  return full;
}

function setPdfPageDisplay(pageNum, totalPages) {
  const inp = $("pdf-page-input");
  const tot = $("pdf-page-total");
  if (inp && document.activeElement !== inp) {
    inp.value = pageNum ? String(pageNum) : "";
  }
  if (tot) {
    tot.textContent = totalPages ? `/ ${totalPages}` : "/ —";
  }
}

function clearTextLayerHighlights(slot) {
  if (!slot) return;
  const tl = slot.querySelector(".textLayer");
  if (!tl) return;
  for (const span of tl.querySelectorAll("span[data-orig-text]")) {
    span.textContent = span.dataset.origText;
    delete span.dataset.origText;
  }
}

function applyTextLayerHighlights(slot, pageNum, query, activeHit) {
  if (!slot) return;
  clearTextLayerHighlights(slot);
  if (!query) return;
  const tl = slot.querySelector(".textLayer");
  if (!tl) return;

  const runs = [];
  let full = "";
  let sawEol = false;
  for (const node of tl.querySelectorAll("span:not(.markedContent), br")) {
    if (node.tagName === "BR") {
      sawEol = true;
      continue;
    }
    const raw = node.textContent || "";
    if (!raw) continue;
    if (full.length > 0 && sawEol && needsLineBreakSpace(full, raw)) {
      full += " ";
    }
    const start = full.length;
    full += raw;
    const end = full.length;
    runs.push({ span: node, raw, start, end });
    sawEol = false;
  }
  if (!full) return;

  const re = new RegExp(escapeRegExp(query), "gi");
  const matches = [];
  let pageMatchIdx = 0;
  let m;
  while ((m = re.exec(full)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length, idx: pageMatchIdx++ });
  }
  if (!matches.length) return;

  let mPtr = 0;
  for (const run of runs) {
    while (mPtr < matches.length && matches[mPtr].end <= run.start) {
      mPtr += 1;
    }
    if (mPtr >= matches.length || matches[mPtr].start >= run.end) continue;

    run.span.dataset.origText = run.raw;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let k = mPtr;
    while (k < matches.length && matches[k].start < run.end) {
      const mt = matches[k];
      const lo = Math.max(0, mt.start - run.start);
      const hi = Math.min(run.raw.length, mt.end - run.start);
      if (lo > cursor) {
        frag.appendChild(document.createTextNode(run.raw.slice(cursor, lo)));
      }
      if (hi > lo) {
        const mark = document.createElement("mark");
        const isCur = activeHit && activeHit.pageNum === pageNum && activeHit.matchIdxInPage === mt.idx;
        mark.className = isCur ? "pdf-hit is-current" : "pdf-hit";
        mark.dataset.hitIdx = String(mt.idx);
        mark.textContent = run.raw.slice(lo, hi);
        frag.appendChild(mark);
        cursor = hi;
      }
      if (mt.end <= run.end) {
        k += 1;
      } else {
        break;
      }
    }
    if (cursor < run.raw.length) {
      frag.appendChild(document.createTextNode(run.raw.slice(cursor)));
    }
    run.span.replaceChildren(frag);
  }
}

function wirePdfModalControls() {
  if (pdfModalWired) return;
  pdfModalWired = true;

  const modal = $("pdf-modal");
  const btnClose = $("pdf-close");
  const btnPrev = $("pdf-prev");
  const btnNext = $("pdf-next");
  const btnZoomIn = $("pdf-zoom-in");
  const btnZoomOut = $("pdf-zoom-out");
  const btnZoomReset = $("pdf-zoom-ind");
  const pageInput = $("pdf-page-input");
  const btnFindToggle = $("pdf-find-toggle");
  const findBar = $("pdf-find-bar");
  const findInput = $("pdf-find-input");
  const btnFindPrev = $("pdf-find-prev");
  const btnFindNext = $("pdf-find-next");
  const btnFindClose = $("pdf-find-close");
  const extLink = $("pdf-ext-link");
  const dlLink = $("pdf-dl-link");

  if (btnClose) btnClose.addEventListener("click", () => closePdfReader("close"));
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closePdfReader("close");
    });
  }

  const goToPage = (targetPage, smooth = false) => {
    if (!pdfSession || !pdfSession.totalPages) return;
    const clamped = Math.min(pdfSession.totalPages, Math.max(1, Math.round(targetPage)));
    const slot = pdfSession.slots[clamped - 1];
    if (slot) {
      slot.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
      if (clamped !== pdfSession.activePage) {
        commitCurrentPdfPageDwell();
        pdfSession.activePage = clamped;
        pdfSession.pagesViewed.add(clamped);
        if (clamped > pdfSession.maxPage) pdfSession.maxPage = clamped;
        checkPdfMilestones();
        if (typeof pdfSession.evictDistantPages === "function") {
          pdfSession.evictDistantPages(clamped);
        }
      }
      if (typeof pdfSession.ensurePageRendered === "function") {
        pdfSession.ensurePageRendered(clamped);
      }
    }
    setPdfPageDisplay(clamped, pdfSession.totalPages);
  };

  const jumpPage = (delta) => {
    if (!pdfSession) return;
    goToPage((pdfSession.activePage || 1) + delta, true);
  };

  if (btnPrev) btnPrev.addEventListener("click", () => jumpPage(-1));
  if (btnNext) btnNext.addEventListener("click", () => jumpPage(1));

  if (pageInput) {
    let cancelPageJump = false;
    pageInput.addEventListener("focus", () => {
      cancelPageJump = false;
      pageInput.select();
    });
    pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        cancelPageJump = false;
        const n = parseInt(pageInput.value.trim(), 10);
        if (!Number.isNaN(n) && pdfSession) {
          goToPage(n);
        } else if (pdfSession) {
          pageInput.value = String(pdfSession.activePage);
        }
        pageInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelPageJump = true;
        if (pdfSession) pageInput.value = String(pdfSession.activePage);
        pageInput.blur();
      }
    });
    pageInput.addEventListener("blur", () => {
      if (cancelPageJump) {
        cancelPageJump = false;
        if (pdfSession) pageInput.value = String(pdfSession.activePage);
        return;
      }
      if (pdfSession) {
        const n = parseInt(pageInput.value.trim(), 10);
        if (!Number.isNaN(n) && n !== pdfSession.activePage) {
          goToPage(n);
        } else {
          setPdfPageDisplay(pdfSession.activePage, pdfSession.totalPages);
        }
      }
    });
  }

  const setZoom = (nextZoom) => {
    if (!pdfSession || !pdfSession.pdfDoc) return;
    const next = Math.min(2.0, Math.max(0.75, Math.round(nextZoom * 100) / 100));
    if (next === pdfSession.zoom) return;
    pdfSession.zoom = next;
    if (btnZoomReset) btnZoomReset.textContent = `${Math.round(next * 100)}%`;
    pdfSession.rerenderVisible();
  };

  const changeZoom = (delta) => {
    if (!pdfSession) return;
    setZoom(pdfSession.zoom + delta);
  };

  if (btnZoomIn) btnZoomIn.addEventListener("click", () => changeZoom(0.25));
  if (btnZoomOut) btnZoomOut.addEventListener("click", () => changeZoom(-0.25));
  if (btnZoomReset) btnZoomReset.addEventListener("click", () => setZoom(1.0));

  const openFindBar = () => {
    if (!pdfSession || !findBar) return;
    findBar.hidden = false;
    if (btnFindToggle) btnFindToggle.classList.add("is-active");
    if (findInput) {
      findInput.focus();
      findInput.select();
    }
  };

  const closeFindBar = () => {
    if (pdfFindTimer) {
      clearTimeout(pdfFindTimer);
      pdfFindTimer = null;
    }
    const restoreFocus = findBar?.contains(document.activeElement);
    if (findBar) findBar.hidden = true;
    if (restoreFocus) btnFindToggle?.focus();
    if (btnFindToggle) btnFindToggle.classList.remove("is-active");
    if (pdfSession && typeof pdfSession.clearSearch === "function") {
      pdfSession.clearSearch();
    }
  };

  if (btnFindToggle) {
    btnFindToggle.addEventListener("click", () => {
      if (findBar && !findBar.hidden) {
        closeFindBar();
      } else {
        openFindBar();
      }
    });
  }
  if (btnFindClose) btnFindClose.addEventListener("click", closeFindBar);

  if (findInput) {
    findInput.addEventListener("input", () => {
      if (pdfFindTimer) clearTimeout(pdfFindTimer);
      const q = (findInput.value || "").trim();
      pdfFindTimer = setTimeout(() => {
        pdfFindTimer = null;
        if (pdfSession && typeof pdfSession.runSearch === "function") {
          pdfSession.runSearch(q);
        }
      }, 240);
    });
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (pdfFindTimer) {
          clearTimeout(pdfFindTimer);
          pdfFindTimer = null;
        }
        const q = (findInput.value || "").trim();
        if (pdfSession) {
          if (q !== pdfSession.findQuery) {
            if (typeof pdfSession.runSearch === "function") {
              pdfSession.runSearch(q);
            }
          } else if (typeof pdfSession.stepSearch === "function") {
            pdfSession.stepSearch(e.shiftKey ? -1 : 1);
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeFindBar();
      }
    });
  }
  if (btnFindPrev) {
    btnFindPrev.addEventListener("click", () => {
      if (pdfSession && typeof pdfSession.stepSearch === "function") pdfSession.stepSearch(-1);
    });
  }
  if (btnFindNext) {
    btnFindNext.addEventListener("click", () => {
      if (pdfSession && typeof pdfSession.stepSearch === "function") pdfSession.stepSearch(1);
    });
  }

  if (extLink) {
    extLink.addEventListener("click", () => {
      if (pdfSession) {
        track("pdf_open_native", { batch_id: pdfSession.batchId, filename: pdfSession.filename });
      }
    });
  }

  if (dlLink) {
    dlLink.addEventListener("click", () => {
      if (!pdfSession) return;
      setTimeout(refreshStatsInPlace, 3200);
      track("file_download", {
        batch_id: pdfSession.batchId,
        filename: pdfSession.filename,
        href: dlLink.getAttribute("href"),
        from: "pdf_reader",
      });
    });
  }

  window.addEventListener("keydown", (e) => {
    if (!pdfSession) return;
    if (e.key === "Tab") {
      const focusable = [...modal.querySelectorAll("button, a[href], input")].filter(
        (el) => !el.disabled && el.getClientRects().length > 0
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && (!focusable.includes(document.activeElement) ||
          document.activeElement === (e.shiftKey ? first : last))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFindBar();
      return;
    }
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    const inInput = tag === "INPUT" || tag === "TEXTAREA";
    if (e.key === "Escape") {
      e.preventDefault();
      if (findBar && !findBar.hidden) {
        closeFindBar();
      } else {
        closePdfReader("close");
      }
      return;
    }
    if (inInput) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      jumpPage(-1);
    } else if (e.key === "ArrowRight" || e.key === "PageDown") {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      jumpPage(1);
    } else if (e.key === "+" || e.key === "=") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      changeZoom(0.25);
    } else if (e.key === "-") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      changeZoom(-0.25);
    } else if (e.key === "0") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      setZoom(1.0);
    }
  });
}

async function openPdfReader(item, batchId, viewHref, dlHref, trigger) {
  wirePdfModalControls();
  if (pdfSession) closePdfReader("retry");

  const modal = $("pdf-modal");
  const titleEl = $("pdf-title");
  const zoomInd = $("pdf-zoom-ind");
  const extLink = $("pdf-ext-link");
  const dlLink = $("pdf-dl-link");
  const statusEl = $("pdf-status");
  const statusText = $("pdf-status-text");
  const progressBar = $("pdf-progress-bar");
  const progressTrack = progressBar?.parentElement;
  const retryButton = $("pdf-load-retry");
  const findCount = $("pdf-find-count");
  const stageEl = $("pdf-stage");
  const pagesEl = $("pdf-pages");

  if (!modal || !pagesEl || !stageEl) {
    window.open(viewHref, "_blank", "noopener,noreferrer");
    return;
  }

  titleEl.textContent = item.name;
  setPdfPageDisplay(1, 0);
  if (zoomInd) zoomInd.textContent = "100%";
  extLink.href = viewHref;
  dlLink.href = dlHref;
  dlLink.setAttribute("download", item.name);
  if (statusText) statusText.textContent = "正在连接并准备首屏渲染…";
  if (progressBar) {
    progressBar.style.width = "18%";
    progressBar.classList.add("is-indeterminate");
  }
  if (statusEl) statusEl.hidden = false;
  if (progressTrack) progressTrack.hidden = false;
  if (retryButton) {
    retryButton.hidden = true;
    retryButton.onclick = () => openPdfReader(item, batchId, viewHref, dlHref, trigger);
  }
  pagesEl.replaceChildren();
  stageEl.scrollTop = 0;

  modal.hidden = false;
  document.querySelector(".viewport-shell").inert = true;
  document.body.style.overflow = "hidden";
  $("pdf-close").focus();

  const EVICT_RADIUS = 5;
  const sess = {
    batchId,
    filename: item.name,
    openPerf: performance.now(),
    pageEnterPerf: performance.now(),
    totalPages: 0,
    activePage: 1,
    maxPage: 1,
    pagesViewed: new Set([1]),
    pageDwellMs: {},
    milestonesSent: new Set(),
    zoom: 1.0,
    slots: [],
    renderedZoom: new Map(),
    renderTasks: new Map(),
    pageSizes: new Map(),
    textCache: new Map(),
    findQuery: "",
    findHits: [],
    findIdx: -1,
    findToken: 0,
    focusToken: 0,
    loadingTask: null,
    pdfDoc: null,
    renderObs: null,
    viewObs: null,
    resizeObs: null,
    resizeTimer: null,
    flushedClose: false,
    trigger,
    rerenderVisible: () => {},
    ensurePageRendered: async () => {},
    evictDistantPages: () => {},
    runSearch: async () => {},
    stepSearch: () => {},
    clearSearch: () => {},
  };
  pdfSession = sess;

  try {
    const pdfjs = await getPdfJsLib();
    if (pdfSession !== sess) return;

    const loadStartPerf = performance.now();
    const loadingTask = pdfjs.getDocument({
      url: viewHref,
      withCredentials: true,
      rangeChunkSize: 131072,
      disableRange: false,
      disableStream: false,
      disableAutoFetch: true,
      cMapUrl: "/u/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/u/pdfjs/standard_fonts/",
      wasmUrl: "/u/pdfjs/wasm/",
    });
    sess.loadingTask = loadingTask;

    loadingTask.onProgress = ({ loaded, total }) => {
      if (pdfSession !== sess || !statusEl || statusEl.hidden) return;
      const elapsedS = Math.max(0.15, (performance.now() - loadStartPerf) / 1000);
      const speedStr = `${fmt(Math.round(loaded / elapsedS))}/s`;
      const effectiveTotal = total || item.bytes || 0;
      if (effectiveTotal > 0) {
        const pct = Math.min(99, Math.max(4, Math.round((loaded / effectiveTotal) * 100)));
        if (progressBar) {
          progressBar.classList.remove("is-indeterminate");
          progressBar.style.width = `${pct}%`;
        }
        if (statusText) {
          statusText.textContent = `正在加载文档… ${pct}% · ${fmt(loaded)} / ${fmt(effectiveTotal)} (${speedStr})`;
        }
      } else if (loaded > 0 && statusText) {
        statusText.textContent = `正在加载文档… 已接收 ${fmt(loaded)} (${speedStr})`;
      }
    };

    const pdfDoc = await loadingTask.promise;
    if (pdfSession !== sess) {
      pdfDoc.destroy();
      return;
    }

    sess.pdfDoc = pdfDoc;
    sess.totalPages = pdfDoc.numPages;
    setPdfPageDisplay(1, pdfDoc.numPages);
    if (progressBar) {
      progressBar.classList.remove("is-indeterminate");
      progressBar.style.width = "100%";
    }
    if (statusEl) statusEl.hidden = true;

    track("pdf_view_open", {
      batch_id: batchId,
      filename: item.name,
      total_pages: pdfDoc.numPages,
      load_ms: Math.round(performance.now() - loadStartPerf),
    });
    checkPdfMilestones();

    const firstPage = await pdfDoc.getPage(1);
    if (pdfSession !== sess) return;
    const baseVp = firstPage.getViewport({ scale: 1 });
    sess.pageSizes.set(1, { width: baseVp.width, height: baseVp.height });
    const computeBaseFitScale = () => {
      const stageW = stageEl.clientWidth || 320;
      const maxStageW = Math.max(280, Math.min(860, stageW - 28));
      return maxStageW / baseVp.width;
    };
    let baseFitScale = computeBaseFitScale();

    const sizeSlot = (pageNum, zoom) => {
      const slot = sess.slots[pageNum - 1];
      if (!slot) return;
      const sz = sess.pageSizes.get(pageNum) || { width: baseVp.width, height: baseVp.height };
      const cssScale = baseFitScale * zoom;
      slot.style.width = `${Math.round(sz.width * cssScale)}px`;
      slot.style.minHeight = `${Math.round(sz.height * cssScale)}px`;
    };

    const getCachedTextContent = async (pageNum, pageObj = null) => {
      if (sess.textCache.has(pageNum)) return sess.textCache.get(pageNum);
      const pg = pageObj || (await sess.pdfDoc.getPage(pageNum));
      const tc = await pg.getTextContent();
      sess.textCache.set(pageNum, tc);
      return tc;
    };

    const clearSlotCanvas = (pageNum) => {
      const slot = sess.slots[pageNum - 1];
      if (slot) {
        const canvas = slot.querySelector("canvas");
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
          canvas.remove();
        }
        const tl = slot.querySelector(".textLayer");
        if (tl) tl.remove();
      }
      sess.renderedZoom.delete(pageNum);
    };

    const evictDistantPages = (centerPage) => {
      const center = centerPage || sess.activePage || 1;
      for (let p = 1; p <= sess.totalPages; p++) {
        if (Math.abs(p - center) <= EVICT_RADIUS) continue;
        if (!sess.renderedZoom.has(p) && !sess.renderTasks.has(p)) continue;
        const pending = sess.renderTasks.get(p);
        if (pending) {
          try {
            if (pending.renderTask) pending.renderTask.cancel();
          } catch (_) {}
          try {
            if (pending.textLayerTask) pending.textLayerTask.cancel();
          } catch (_) {}
          sess.renderTasks.delete(p);
        }
        clearSlotCanvas(p);
      }
    };
    sess.evictDistantPages = evictDistantPages;

    const showPageRenderError = (slot, pageNum) => {
      if (!slot) return;
      const prev = slot.querySelector(".pdf-page-err");
      if (prev) prev.remove();
      const wrap = document.createElement("div");
      wrap.className = "pdf-page-err";
      const msg = document.createElement("span");
      msg.textContent = `第 ${pageNum} 页加载失败`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "pdf-retry-btn";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => {
        wrap.remove();
        sess.renderedZoom.delete(pageNum);
        renderPageNum(pageNum);
      });
      wrap.append(msg, retry);
      slot.appendChild(wrap);
    };

    const renderPageNum = (pageNum) => {
      if (pdfSession !== sess || !sess.pdfDoc) return Promise.resolve();
      const targetZoom = sess.zoom;
      const targetKey = `${baseFitScale.toFixed(4)}:${targetZoom}`;
      if (sess.renderedZoom.get(pageNum) === targetKey) return Promise.resolve();

      const existing = sess.renderTasks.get(pageNum);
      if (existing) {
        if (existing.key === targetKey) {
          return existing.promise;
        }
        try {
          if (existing.renderTask) existing.renderTask.cancel();
        } catch (_) {}
        try {
          if (existing.textLayerTask) existing.textLayerTask.cancel();
        } catch (_) {}
      }

      const entry = {
        key: targetKey,
        zoom: targetZoom,
        renderTask: null,
        textLayerTask: null,
        promise: null,
      };
      const prevPromise = existing ? existing.promise.catch(() => {}) : Promise.resolve();

      const run = (async () => {
        await prevPromise;
        if (pdfSession !== sess || !sess.pdfDoc || sess.renderTasks.get(pageNum) !== entry) return;
        const slot = sess.slots[pageNum - 1];
        if (!slot) return;
        const oldErr = slot.querySelector(".pdf-page-err");
        if (oldErr) oldErr.remove();

        let page = null;
        try {
          page = await sess.pdfDoc.getPage(pageNum);
          if (pdfSession !== sess || sess.renderTasks.get(pageNum) !== entry) return;

          const vp1 = page.getViewport({ scale: 1 });
          sess.pageSizes.set(pageNum, { width: vp1.width, height: vp1.height });

          const cssScale = baseFitScale * targetZoom;
          const vp = page.getViewport({ scale: cssScale });
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const renderVp = page.getViewport({ scale: cssScale * dpr });

          const cssW = Math.round(vp.width);
          const cssH = Math.round(vp.height);
          slot.style.width = `${cssW}px`;
          slot.style.minHeight = `${cssH}px`;
          slot.style.setProperty("--total-scale-factor", String(cssScale));

          let canvas = slot.querySelector("canvas");
          if (!canvas) {
            canvas = document.createElement("canvas");
            slot.insertBefore(canvas, slot.firstChild);
          }
          canvas.width = Math.round(renderVp.width);
          canvas.height = Math.round(renderVp.height);
          canvas.style.width = `${cssW}px`;
          canvas.style.height = `${cssH}px`;

          const ctx = canvas.getContext("2d", { alpha: false });
          const renderTask = page.render({ canvasContext: ctx, viewport: renderVp });
          entry.renderTask = renderTask;
          await renderTask.promise;
          if (pdfSession !== sess || sess.renderTasks.get(pageNum) !== entry) return;

          // Overlay selectable TextLayer for copy & in-document search
          if (typeof pdfjs.TextLayer === "function") {
            try {
              const textContent = await getCachedTextContent(pageNum, page);
              if (pdfSession !== sess || sess.renderTasks.get(pageNum) !== entry) return;
              const prevTl = slot.querySelector(".textLayer");
              if (prevTl) prevTl.remove();
              const textDiv = document.createElement("div");
              textDiv.className = "textLayer";
              const tagEl = slot.querySelector(".pdf-page-tag");
              slot.insertBefore(textDiv, tagEl || null);
              const tl = new pdfjs.TextLayer({
                textContentSource: textContent,
                container: textDiv,
                viewport: vp,
              });
              entry.textLayerTask = tl;
              await tl.render();
              if (pdfSession !== sess || sess.renderTasks.get(pageNum) !== entry) return;
              if (sess.findQuery) {
                const curHit = sess.findIdx >= 0 ? sess.findHits[sess.findIdx] : null;
                applyTextLayerHighlights(slot, pageNum, sess.findQuery, curHit);
              }
            } catch (_) {}
          }

          sess.renderedZoom.set(pageNum, targetKey);
          evictDistantPages(sess.activePage);
        } catch (err) {
          const isCancelled =
            err && (err.name === "RenderingCancelledException" || err.name === "AbortException");
          if (!isCancelled && pdfSession === sess && sess.renderTasks.get(pageNum) === entry) {
            showPageRenderError(slot, pageNum);
          }
        } finally {
          if (page) {
            try {
              page.cleanup();
            } catch (_) {}
          }
          if (sess.renderTasks.get(pageNum) === entry) {
            sess.renderTasks.delete(pageNum);
          }
        }
      })();

      entry.promise = run;
      sess.renderTasks.set(pageNum, entry);
      return run;
    };

    sess.ensurePageRendered = renderPageNum;

    const refreshAllVisibleHighlights = () => {
      const curHit = sess.findIdx >= 0 ? sess.findHits[sess.findIdx] : null;
      for (let i = 0; i < sess.slots.length; i++) {
        applyTextLayerHighlights(sess.slots[i], i + 1, sess.findQuery, curHit);
      }
    };

    const focusCurrentHit = async () => {
      if (!sess.findHits.length || sess.findIdx < 0) return;
      const myFocusToken = ++sess.focusToken;
      const hit = sess.findHits[sess.findIdx];
      if (findCount) {
        findCount.textContent = `${sess.findIdx + 1} / ${sess.findHits.length}`;
        findCount.classList.remove("is-empty");
      }
      const slot = sess.slots[hit.pageNum - 1];
      if (!slot) return;
      slot.scrollIntoView({ behavior: "auto", block: "center" });
      await renderPageNum(hit.pageNum);
      if (pdfSession !== sess || sess.focusToken !== myFocusToken) return;
      refreshAllVisibleHighlights();
      const mark = slot.querySelector(`mark.pdf-hit[data-hit-idx="${hit.matchIdxInPage}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: "auto", block: "center" });
      }
    };

    sess.clearSearch = () => {
      sess.findToken += 1;
      sess.focusToken += 1;
      sess.findQuery = "";
      sess.findHits = [];
      sess.findIdx = -1;
      if (findCount) {
        findCount.textContent = "";
        findCount.classList.remove("is-empty");
      }
      for (const slot of sess.slots) clearTextLayerHighlights(slot);
    };

    sess.stepSearch = (delta) => {
      if (!sess.findHits.length) return;
      sess.findIdx = (sess.findIdx + delta + sess.findHits.length) % sess.findHits.length;
      focusCurrentHit();
    };

    sess.runSearch = async (query) => {
      const myToken = ++sess.findToken;
      sess.findQuery = query;
      sess.findHits = [];
      sess.findIdx = -1;
      if (!query) {
        sess.clearSearch();
        return;
      }
      const re = new RegExp(escapeRegExp(query), "gi");
      const hits = [];
      for (let p = 1; p <= sess.totalPages; p++) {
        if (pdfSession !== sess || sess.findToken !== myToken) return;
        if (findCount && sess.totalPages > 5) {
          findCount.textContent = `检索 ${p}/${sess.totalPages}`;
          findCount.classList.remove("is-empty");
        }
        try {
          const tc = await getCachedTextContent(p);
          const fullText = buildPageSearchText(tc.items);
          if (fullText) {
            re.lastIndex = 0;
            let matchIdxInPage = 0;
            let m;
            while ((m = re.exec(fullText)) !== null) {
              if (m[0].length === 0) {
                re.lastIndex += 1;
                continue;
              }
              hits.push({ pageNum: p, matchIdxInPage });
              matchIdxInPage += 1;
            }
          }
        } catch (_) {}
      }
      if (pdfSession !== sess || sess.findToken !== myToken) return;
      sess.findHits = hits;
      track("pdf_search", {
        batch_id: batchId,
        filename: item.name,
        q: query.slice(0, 80),
        hits: hits.length,
      });
      if (!hits.length) {
        refreshAllVisibleHighlights();
        if (findCount) {
          findCount.textContent = "无匹配";
          findCount.classList.add("is-empty");
        }
        return;
      }
      // Prefer first hit on or after current active page
      let startIdx = hits.findIndex((h) => h.pageNum >= sess.activePage);
      if (startIdx < 0) startIdx = 0;
      sess.findIdx = startIdx;
      await focusCurrentHit();
    };

    const frag = document.createDocumentFragment();
    const estW = Math.round(baseVp.width * baseFitScale);
    const estH = Math.round(baseVp.height * baseFitScale);
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const slot = document.createElement("div");
      slot.className = "pdf-page-slot";
      slot.dataset.page = String(i);
      slot.style.width = `${estW}px`;
      slot.style.minHeight = `${estH}px`;

      const tag = document.createElement("span");
      tag.className = "pdf-page-tag";
      tag.textContent = `${i} / ${pdfDoc.numPages}`;
      slot.appendChild(tag);

      sess.slots.push(slot);
      frag.appendChild(slot);
    }
    pagesEl.appendChild(frag);

    const visibleSet = new Set([1]);
    sess.rerenderVisible = () => {
      for (let i = 1; i <= sess.totalPages; i++) {
        sizeSlot(i, sess.zoom);
        if (!visibleSet.has(i) && i !== sess.activePage) {
          const pending = sess.renderTasks.get(i);
          if (pending) {
            try {
              if (pending.renderTask) pending.renderTask.cancel();
            } catch (_) {}
            try {
              if (pending.textLayerTask) pending.textLayerTask.cancel();
            } catch (_) {}
            sess.renderTasks.delete(i);
          }
          clearSlotCanvas(i);
        }
      }
      sess.renderedZoom.clear();
      for (const p of visibleSet) renderPageNum(p);
      if (sess.activePage && !visibleSet.has(sess.activePage)) {
        renderPageNum(sess.activePage);
      }
    };

    if (typeof ResizeObserver === "function") {
      let lastStageW = stageEl.clientWidth;
      sess.resizeObs = new ResizeObserver(() => {
        if (pdfSession !== sess) return;
        const curW = stageEl.clientWidth;
        if (!curW || Math.abs(curW - lastStageW) < 8) return;
        if (sess.resizeTimer) clearTimeout(sess.resizeTimer);
        sess.resizeTimer = setTimeout(() => {
          sess.resizeTimer = null;
          if (pdfSession !== sess) return;
          const w = stageEl.clientWidth;
          if (!w || Math.abs(w - lastStageW) < 8) return;
          lastStageW = w;
          const nextScale = computeBaseFitScale();
          if (Math.abs(nextScale - baseFitScale) > 0.005) {
            baseFitScale = nextScale;
            sess.rerenderVisible();
          }
        }, 180);
      });
      sess.resizeObs.observe(stageEl);
    }

    sess.renderObs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const p = Number(en.target.dataset.page);
          if (en.isIntersecting) {
            visibleSet.add(p);
            renderPageNum(p);
            if (p + 1 <= sess.totalPages) renderPageNum(p + 1);
          } else {
            visibleSet.delete(p);
          }
        }
      },
      { root: stageEl, rootMargin: "420px 0px" }
    );

    const ratios = new Map();
    sess.viewObs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const p = Number(en.target.dataset.page);
          ratios.set(p, en.isIntersecting ? en.intersectionRatio : 0);
        }
        let bestPage = sess.activePage;
        let bestRatio = 0;
        for (const [p, r] of ratios.entries()) {
          if (r > bestRatio) {
            bestRatio = r;
            bestPage = p;
          }
        }
        if (bestRatio > 0 && bestPage !== sess.activePage) {
          commitCurrentPdfPageDwell();
          sess.activePage = bestPage;
          sess.pagesViewed.add(bestPage);
          if (bestPage > sess.maxPage) sess.maxPage = bestPage;
          setPdfPageDisplay(bestPage, sess.totalPages);
          checkPdfMilestones();
          evictDistantPages(bestPage);
        }
      },
      { root: stageEl, threshold: [0, 0.25, 0.5, 0.75] }
    );

    for (const slot of sess.slots) {
      sess.renderObs.observe(slot);
      sess.viewObs.observe(slot);
    }
    renderPageNum(1);
    if (pdfDoc.numPages >= 2) renderPageNum(2);
  } catch (err) {
    if (pdfSession !== sess) return;
    const httpStatus = err && (err.status || (err.cause && err.cause.status));
    if (httpStatus === 401 || httpStatus === 403) {
      closePdfReader("auth_expired");
      if (typeof handleSessionExpired === "function") {
        handleSessionExpired("口令会话已过期，请重新输入口令");
      }
      return;
    }
    if (statusText) statusText.textContent = "文档预览加载失败。你可以重试、在新标签打开或下载。";
    if (progressBar) progressBar.classList.remove("is-indeterminate");
    if (progressTrack) progressTrack.hidden = true;
    if (retryButton) retryButton.hidden = false;
    if (statusEl) statusEl.hidden = false;
    track("pdf_reader_fallback", { filename: item.name, error: String(err?.message || err) });
  }
}

async function loadManifest() {
  wireDeliveryControls();
  const myEpoch = authEpoch;
  if (manifestAbort) {
    try {
      manifestAbort.abort();
    } catch (_) {}
  }
  const ctrl = new AbortController();
  manifestAbort = ctrl;

  const root = $("delivery-root");
  if (root && !manifestData) {
    root.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "delivery-state";
    loading.textContent = "正在加载交付记录…";
    root.appendChild(loading);
  }

  try {
    const [mRes, sRes] = await Promise.all([
      fetch("/u/manifest.json", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: ctrl.signal,
      }),
      fetch("/u/stats.json", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: ctrl.signal,
      }).catch(() => null),
    ]);
    if (myEpoch !== authEpoch) return;
    if (mRes.status === 401 || mRes.status === 403) {
      if (typeof handleSessionExpired === "function") {
        handleSessionExpired("口令会话已过期，请重新输入口令");
      }
      return;
    }
    if (!mRes.ok) throw new Error(`HTTP ${mRes.status}`);
    const nextManifest = await mRes.json();
    if (myEpoch !== authEpoch) return;
    manifestData = nextManifest;
    if (sRes && sRes.ok) {
      try {
        const statsJson = await sRes.json();
        if (myEpoch !== authEpoch) return;
        downloadCounts = readDownloadCounts(statsJson);
        inboxReceipts = Array.isArray(statsJson && statsJson.receipts) ? statsJson.receipts : [];
      } catch (_) {
        downloadCounts = {};
        inboxReceipts = [];
      }
    } else {
      downloadCounts = {};
      inboxReceipts = [];
    }
    if (myEpoch !== authEpoch) return;
    renderReceipts();
    renderDeliveries();
  } catch (err) {
    if (myEpoch !== authEpoch || (err && err.name === "AbortError")) return;
    if (root) {
      root.replaceChildren();
      const errEl = document.createElement("p");
      errEl.className = "delivery-state";
      errEl.textContent = "交付清单加载失败，请刷新页面重试";
      root.appendChild(errEl);
    }
  } finally {
    if (manifestAbort === ctrl) manifestAbort = null;
  }
}

function clearDeliveries() {
  authEpoch += 1;
  if (manifestAbort) {
    try {
      manifestAbort.abort();
    } catch (_) {}
    manifestAbort = null;
  }
  if (statsAbort) {
    try {
      statsAbort.abort();
    } catch (_) {}
    statsAbort = null;
  }
  if (pdfSession) closePdfReader("lock");
  manifestData = null;
  downloadCounts = {};
  inboxReceipts = [];
  badgeNodes.clear();
  batchSumNodes.clear();
  searchQuery = "";
  activeTab = "all";
  const searchEl = $("delivery-search");
  if (searchEl) searchEl.value = "";
  const dragVeil = $("drag-veil");
  if (dragVeil) dragVeil.hidden = true;
  const rcpt = $("receipt-root");
  if (rcpt) {
    rcpt.hidden = true;
    rcpt.replaceChildren();
  }
  const root = $("delivery-root");
  if (root) {
    root.replaceChildren();
  }
}

async function boot() {
  const viewGate = $("view-gate");
  const viewWs = $("view-ws");
  const gateForm = $("gate-form");
  const capsuleBar = $("capsule-bar");
  const pwdInput = $("pwd-input");
  const gateErr = $("gate-err");
  const btnUnlock = $("btn-unlock");
  const unlockLabel = $("unlock-label");
  const btnLock = $("btn-lock");
  const btnRetryLogout = $("btn-retry-logout");
  const logoutKey = "u_logout_pending";
  let logoutPending = false;
  let logoutInFlight = false;
  let authAttempts = 0;

  function saveLogoutPending(pending) {
    logoutPending = pending;
    for (const storageName of ["localStorage", "sessionStorage"]) {
      try {
        if (pending) {
          window[storageName].setItem(logoutKey, "1");
          return;
        }
        window[storageName].removeItem(logoutKey);
      } catch (_) {}
    }
  }

  function restoreLogoutPending() {
    return ["localStorage", "sessionStorage"].some((storageName) => {
      try {
        return window[storageName].getItem(logoutKey) === "1";
      } catch (_) {
        return false;
      }
    });
  }

  async function requestAuth(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function showGateMessage(message) {
    gateErr.textContent = message;
    gateErr.hidden = !message;
  }

  function updateLogoutControls(message) {
    pwdInput.disabled = logoutPending;
    btnUnlock.disabled = logoutPending;
    btnRetryLogout.hidden = !logoutPending || logoutInFlight;
    showGateMessage(message);
  }

  async function finishLogout() {
    if (logoutInFlight) return;
    logoutInFlight = true;
    updateLogoutControls("正在退出…");
    let confirmed = false;
    try {
      const res = await requestAuth("/u/logout", { method: "POST" });
      confirmed = res.status === 204;
    } catch (_) {
    } finally {
      logoutInFlight = false;
    }
    if (confirmed) saveLogoutPending(false);
    updateLogoutControls(confirmed ? "" : "退出尚未确认，请重试。");
    if (!confirmed) btnRetryLogout.focus();
    else if (window.innerWidth >= 760) pwdInput.focus();
  }

  function showUnlocked() {
    gateErr.hidden = true;
    viewGate.hidden = true;
    viewWs.hidden = false;
    initUppy();
    loadManifest();
  }

  function showLocked() {
    clearDeliveries();
    viewWs.hidden = true;
    viewGate.hidden = false;
    pwdInput.value = "";
    if (!logoutPending && window.innerWidth >= 760) pwdInput.focus();
  }

  function clearUppyQueueOnLock() {
    if (!uppyInstance) return;
    const hasActive = uppyInstance
      .getFiles()
      .some((f) => f.progress && f.progress.uploadStarted && !f.progress.uploadComplete && !f.error);
    batchUploading = false;
    if (hasActive) {
      uppyInstance.cancelAll();
    }
    for (const k of Array.from(thumbUrls.keys())) revokeThumb(k);
    fileUploadMeta.clear();
    resetUploadSpeedState();
    releaseWake();
    uppyInstance.clear();
    renderQueue(uppyInstance);
  }

  handleSessionExpired = (msg) => {
    const wasUnlocked = !viewWs.hidden;
    if (wasUnlocked) {
      clearUppyQueueOnLock();
      showLocked();
    }
    if (msg && gateErr) {
      gateErr.textContent = msg;
      gateErr.hidden = false;
    }
  };

  function triggerShake() {
    if (!capsuleBar) return;
    capsuleBar.classList.remove("is-shake");
    void capsuleBar.offsetWidth;
    capsuleBar.classList.add("is-shake");
  }

  let initialState = "locked";
  logoutPending = restoreLogoutPending();
  showLocked();
  if (logoutPending) {
    updateLogoutControls("上次退出尚未确认，请重试。");
  } else {
    btnUnlock.disabled = true;
    try {
      const res = await requestAuth("/u/auth", { method: "GET" });
      if (res.status === 204 && !restoreLogoutPending()) {
        initialState = "unlocked";
        showUnlocked();
      } else if (res.status === 429) {
        showGateMessage("验证请求过于频繁，请稍后再试。");
      } else if (res.status !== 401 && res.status !== 403) {
        showGateMessage("暂时无法验证会话，请稍后重试。");
      }
    } catch (_) {
      showGateMessage("暂时无法连接服务器，请稍后重试。");
    } finally {
      logoutPending = restoreLogoutPending();
      if (logoutPending) updateLogoutControls("退出尚未确认，请重试。");
      else btnUnlock.disabled = false;
    }
  }

  track("page_open", { initial_state: initialState, enter_epoch_ms: PAGE_ENTER_TS });

  gateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (logoutPending || btnUnlock.disabled) return;
    const pwd = pwdInput.value.trim();
    if (!pwd) {
      gateErr.textContent = "请输入访问口令";
      gateErr.hidden = false;
      triggerShake();
      return;
    }
    authAttempts += 1;
    btnUnlock.disabled = true;
    unlockLabel.textContent = "验证中";
    gateErr.hidden = true;

    const attemptEpoch = authEpoch;
    try {
      const key = await derivePassKey(pwd);
      const res = await requestAuth("/u/auth", {
        method: "POST",
        headers: { "X-Pass-Key": key },
      });
      if (logoutPending || attemptEpoch !== authEpoch) return;
      if (res.status === 204) {
        track("auth_ok", { attempt: authAttempts });
        showUnlocked();
      } else if (res.status === 429) {
        track("auth_rate_limited", { attempt: authAttempts, input_len: pwd.length });
        gateErr.textContent = "尝试过于频繁，请稍后再试";
        gateErr.hidden = false;
        triggerShake();
      } else if (res.status === 401 || res.status === 403) {
        track("auth_fail", {
          attempt: authAttempts,
          input_len: pwd.length,
        });
        gateErr.textContent = "口令不正确，请核对后重试";
        gateErr.hidden = false;
        triggerShake();
        pwdInput.select();
      } else {
        showGateMessage("验证服务暂不可用，请稍后重试。");
      }
    } catch (_) {
      if (!logoutPending && attemptEpoch === authEpoch) showGateMessage("网络连接异常，请稍后重试。");
    } finally {
      btnUnlock.disabled = logoutPending;
      unlockLabel.textContent = "开启";
    }
  });

  btnLock.addEventListener("click", () => {
    saveLogoutPending(true);
    showLocked();
    track("lock", {});
    clearUppyQueueOnLock();
    finishLogout();
  });
  btnRetryLogout.addEventListener("click", finishLogout);

  window.addEventListener("storage", (event) => {
    if (event.key !== logoutKey) return;
    const pending = event.newValue === "1" || restoreLogoutPending();
    if (logoutInFlight || logoutPending === pending) return;
    logoutPending = pending;
    if (pending) {
      showLocked();
      clearUppyQueueOnLock();
    }
    updateLogoutControls(pending ? "退出尚未确认，请重试。" : "");
  });

  // Rich interaction & active-time telemetry
  let activeMs = 0;
  let lastActivityPerf = performance.now();
  let lastTickPerf = performance.now();
  let maxScrollPct = 0;
  const scrollMilestonesSent = new Set();
  let tabSwitches = 0;
  let hiddenAtPerf = null;

  const markActive = () => {
    lastActivityPerf = performance.now();
  };
  for (const evName of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(evName, markActive, { passive: true });
  }

  const updateScrollDepth = () => {
    markActive();
    const docEl = document.documentElement;
    const totalH = Math.max(1, docEl.scrollHeight);
    const viewH = window.innerHeight || 1;
    if (totalH <= viewH + 40) return;
    const pct = Math.min(100, Math.round(((window.scrollY + viewH) / totalH) * 100));
    if (pct > maxScrollPct) {
      maxScrollPct = pct;
      for (const m of [50, 100]) {
        if (pct >= m && !scrollMilestonesSent.has(m)) {
          scrollMilestonesSent.add(m);
          track("scroll_depth", { milestone_pct: m, max_scroll_pct: maxScrollPct });
        }
      }
    }
  };
  window.addEventListener("scroll", updateScrollDepth, { passive: true });

  setInterval(() => {
    const now = performance.now();
    const dt = now - lastTickPerf;
    lastTickPerf = now;
    if (document.visibilityState === "visible" && now - lastActivityPerf <= 15000 && dt > 0 && dt < 5000) {
      activeMs += dt;
    }
  }, 1000);

  document.addEventListener("copy", () => {
    try {
      const sel = window.getSelection ? window.getSelection().toString().trim() : "";
      if (sel) {
        track("text_copy", { text: sel.slice(0, 200), len: sel.length });
      }
    } catch (_) {}
  });

  let prevW = window.innerWidth;
  let prevH = window.innerHeight;
  let prevDpr = window.devicePixelRatio || 1;
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      if (Math.abs(w - prevW) > 40 || Math.abs(h - prevH) > 40 || dpr !== prevDpr) {
        prevW = w;
        prevH = h;
        prevDpr = dpr;
        track("viewport_resize", {
          inner_w: w,
          inner_h: h,
          screen_w: window.screen ? window.screen.width : null,
          screen_h: window.screen ? window.screen.height : null,
          dpr,
        });
      }
    }, 900);
  });

  let leaveSent = false;
  function onLeave(reason) {
    if (reason === "pagehide" && pdfSession && !pdfSession.flushedClose) {
      flushPdfTelemetry("pagehide", true);
    }
    if (leaveSent) return;
    leaveSent = true;
    if (pdfSession && !pdfSession.flushedClose) {
      flushPdfTelemetry(reason, true);
    }
    const payloadStr = JSON.stringify({
      vid: VID,
      sid: SID,
      seq: ++eventSeq,
      event: "page_leave",
      client_ts: new Date().toISOString(),
      dwell_ms: Math.round(performance.now() - PAGE_ENTER_PERF),
      detail: {
        reason,
        active_ms: Math.round(activeMs),
        max_scroll_pct: maxScrollPct,
        tab_switches: tabSwitches,
      },
    });
    const endpoint = `/u/track?ev=page_leave&vid=${encodeURIComponent(VID)}&sid=${encodeURIComponent(SID)}`;
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payloadStr], { type: "application/json" }));
      }
    } catch (_) {}
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAtPerf = performance.now();
      tabSwitches += 1;
      onLeave("visibility_hidden");
    } else {
      leaveSent = false;
      markActive();
      resumePdfTimer();
      if (hiddenAtPerf !== null) {
        const awayMs = Math.round(performance.now() - hiddenAtPerf);
        hiddenAtPerf = null;
        track("tab_return", { away_ms: awayMs, tab_switches: tabSwitches });
      }
      refreshStatsInPlace();
    }
  });
  window.addEventListener("pagehide", () => onLeave("pagehide"));
}

boot();
