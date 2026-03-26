import { PANEL_ENABLED_STORAGE_KEY } from "../constants";

function createIconImageData(size: number, active: boolean): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2d context unavailable");
  }
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;

  ctx.clearRect(0, 0, size, size);

  if (active) {
    const glow = ctx.createRadialGradient(
      cx,
      cy,
      r * 0.15,
      cx,
      cy,
      r * 1.25
    );
    glow.addColorStop(0, "rgba(165, 180, 252, 0.55)");
    glow.addColorStop(0.45, "rgba(99, 102, 241, 0.35)");
    glow.addColorStop(1, "rgba(99, 102, 241, 0.02)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = active ? "rgb(99, 102, 241)" : "rgb(52, 52, 58)";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.68, 0, Math.PI * 2);
  ctx.fill();

  if (size >= 16) {
    ctx.strokeStyle = active ? "rgb(199, 210, 254)" : "rgb(110, 110, 118)";
    ctx.lineWidth = Math.max(1, size / 14);
    ctx.lineCap = "round";
    const lensR = r * 0.38;
    ctx.beginPath();
    ctx.arc(cx - lensR * 0.15, cy - lensR * 0.15, lensR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + lensR * 0.45, cy + lensR * 0.45);
    ctx.lineTo(cx + r * 0.85, cy + r * 0.85);
    ctx.stroke();
  }

  return ctx.getImageData(0, 0, size, size);
}

async function applyToolbarIcon(active: boolean): Promise<void> {
  const sizes = [16, 32, 48] as const;
  const imageData: Record<number, ImageData> = {};
  for (const s of sizes) {
    imageData[s] = createIconImageData(s, active);
  }
  await chrome.action.setIcon({ imageData });
}

async function syncToolbarFromStorage(): Promise<void> {
  const v = await chrome.storage.local.get(PANEL_ENABLED_STORAGE_KEY);
  const on = Boolean(v[PANEL_ENABLED_STORAGE_KEY]);
  await applyToolbarIcon(on);
  await chrome.action.setTitle({
    title: on
      ? "mail-sherlock (on) — click to hide panel"
      : "mail-sherlock (off) — click to show panel",
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void syncToolbarFromStorage();
});

chrome.runtime.onStartup.addListener(() => {
  void syncToolbarFromStorage();
});

chrome.action.onClicked.addListener(async () => {
  const v = await chrome.storage.local.get(PANEL_ENABLED_STORAGE_KEY);
  const next = !Boolean(v[PANEL_ENABLED_STORAGE_KEY]);
  await chrome.storage.local.set({ [PANEL_ENABLED_STORAGE_KEY]: next });
  await applyToolbarIcon(next);
  await chrome.action.setTitle({
    title: next
      ? "mail-sherlock (on) — click to hide panel"
      : "mail-sherlock (off) — click to show panel",
  });
});

const LOCAL_API = "http://127.0.0.1:8000";
const ALLOWED_PATHS = new Set(["/ask", "/chat"]);

/**
 * Proxy /ask and /chat from the service worker so requests are not attributed to
 * the active web page. Otherwise Chrome may prompt “this site wants to access
 * other apps / local network” when a content script fetches localhost.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "MAIL_SHERLOCK_API") {
    return false;
  }
  const path = msg.path as string;
  if (!ALLOWED_PATHS.has(path) || typeof msg.body !== "string") {
    sendResponse({
      status: 0,
      bodyText: "",
      error: "Invalid API request",
    });
    return false;
  }
  void (async () => {
    try {
      const res = await fetch(`${LOCAL_API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: msg.body,
      });
      const bodyText = await res.text();
      sendResponse({ status: res.status, bodyText });
    } catch (e) {
      sendResponse({
        status: 0,
        bodyText: "",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  return true;
});
