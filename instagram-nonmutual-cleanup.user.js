// ==UserScript==
// @name         Instagram Non-Mutual Detector
// @namespace    https://local/instagram-nonmutual-cleanup
// @version      2.0.0
// @description  Detect Instagram accounts that don't follow you back, and export your following / followers / non-mutuals to CSV, JSON, or TXT. Same-origin only, no third parties, read-only (never unfollows), light/dark UI.
// @author       you
// @homepageURL  https://github.com/WackyPingu/instagram-nonmutual-cleanup
// @supportURL   https://github.com/WackyPingu/instagram-nonmutual-cleanup/issues
// @downloadURL  https://github.com/WackyPingu/instagram-nonmutual-cleanup/raw/refs/heads/main/instagram-nonmutual-cleanup.user.js
// @updateURL    https://github.com/WackyPingu/instagram-nonmutual-cleanup/raw/refs/heads/main/instagram-nonmutual-cleanup.user.js
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

// Single self-contained userscript, everything inlined in one IIFE. Read-only:
// it loads your following / followers lists via the same-origin internal API,
// computes the non-mutuals (people you follow who don't follow you back), and
// lets you review and export them. It never unfollows or changes anything.
// Every request stays same-origin to instagram.com; no credentials are ever
// requested. The loaded following / followers / non-mutual lists can be exported
// to CSV / JSON / TXT — built in-page and saved locally, nothing is uploaded.

(function () {
  "use strict";

  // ==========================================================================
  // throttle: abortable sleep + jitter
  // ==========================================================================

  /** Thrown when an operation is cancelled via an AbortSignal (user pressed Stop). */
  class AbortError extends Error {
    constructor() {
      super("Aborted");
      this.name = "AbortError";
    }
  }

  /** Inclusive-min, exclusive-max integer in [min, max). */
  function randomBetween(min, max) {
    if (max <= min) return Math.round(min);
    return Math.floor(min + Math.random() * (max - min));
  }

  /**
   * Promise that resolves after `ms`, or rejects with AbortError if the signal
   * fires first. Used for every wait so that Stop is always responsive.
   */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ==========================================================================
  // gm: GM_getValue / GM_setValue wrapper with localStorage fallback
  // ==========================================================================

  // `typeof <name>` is safe on an absent global and never throws (even in strict).
  const hasGM =
    typeof GM_getValue === "function" && typeof GM_setValue === "function";

  const LS_PREFIX = "ig_nmc_";

  function gmGet(key, defaultValue) {
    if (hasGM) {
      try {
        return GM_getValue(key, defaultValue);
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw == null ? defaultValue : JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  }

  function gmSet(key, value) {
    if (hasGM) {
      try {
        GM_setValue(key, value);
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    } catch {
      /* nothing we can do; persistence simply won't survive reloads */
    }
  }

  // ==========================================================================
  // setmath: non-mutual computation + username normalization
  // ==========================================================================

  /** Normalize a username for comparison: trim + lowercase. */
  function normalizeUsername(username) {
    return username.trim().toLowerCase();
  }

  /**
   * Non-mutuals = following - followers.
   *
   * Pure set math on normalized usernames. We intentionally do NOT special-case
   * pending/requested follows. The returned objects are the original `following`
   * entries (so they keep their numeric pk).
   */
  function computeNonMutuals(followingList, followersList) {
    const followerSet = new Set(followersList.map((u) => normalizeUsername(u.username)));

    const seen = new Set();
    const result = [];
    for (const user of followingList) {
      const name = normalizeUsername(user.username);
      if (!name || seen.has(name)) continue;
      if (followerSet.has(name)) continue; // they follow you back -> mutual, keep
      seen.add(name);
      result.push(user);
    }
    return result;
  }

  // ==========================================================================
  // dates / theme key
  // ==========================================================================

  const THEME_KEY = "theme";

  function todayKey() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  // ==========================================================================
  // export: serialize following / followers / non-mutual lists to a file
  // ==========================================================================
  //
  // Purely local: the text is built in-page and saved via a Blob + a temporary
  // <a download> click. Nothing is uploaded and no extra GM grant is required.

  /** CSV-escape one cell (quote it if it holds a comma/quote/newline; double quotes). */
  function csvCell(value) {
    const s = value == null ? "" : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Public profile URL for a username (blank if no username). */
  function profileUrl(username) {
    return username ? "https://www.instagram.com/" + username + "/" : "";
  }

  /** A list of user objects -> CSV text with a header row. */
  function usersToCsv(users) {
    const rows = ["username,full_name,is_private,pk,profile_url"];
    for (const u of users) {
      rows.push(
        [
          csvCell(u.username),
          csvCell(u.full_name),
          csvCell(typeof u.is_private === "boolean" ? String(u.is_private) : ""),
          csvCell(u.pk),
          csvCell(profileUrl(u.username)),
        ].join(","),
      );
    }
    return rows.join("\r\n");
  }

  /** A list of user objects -> pretty JSON with a little export metadata. */
  function usersToJson(type, users) {
    return JSON.stringify(
      {
        type,
        exported_at: new Date().toISOString(),
        count: users.length,
        users: users.map((u) => ({
          username: u.username,
          full_name: u.full_name ?? "",
          is_private: typeof u.is_private === "boolean" ? u.is_private : null,
          pk: u.pk || "",
          profile_url: profileUrl(u.username),
        })),
      },
      null,
      2,
    );
  }

  /** A list of user objects -> one username per line. */
  function usersToTxt(users) {
    return users.map((u) => u.username).filter(Boolean).join("\r\n");
  }

  /** Save `content` to the user's device as `filename` (local Blob download). */
  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000); // let the download start first
  }

  // kind (internal) -> human label used in the filename and the JSON "type".
  const EXPORT_LABELS = {
    nonmutuals: "non-mutuals",
    following: "following",
    followers: "followers",
  };

  /**
   * Serialize `users` in the chosen format ("csv" | "json" | "txt") and trigger
   * the download. Returns the filename that was saved.
   */
  function exportUsers(kind, users, format) {
    const label = EXPORT_LABELS[kind] || kind;
    const base = `instagram-${label}-${todayKey()}`;
    if (format === "json") {
      downloadFile(base + ".json", usersToJson(label, users), "application/json");
      return base + ".json";
    }
    if (format === "txt") {
      downloadFile(base + ".txt", usersToTxt(users), "text/plain");
      return base + ".txt";
    }
    // Default CSV. Lead with a UTF-8 BOM so Excel reads accented names correctly.
    downloadFile(base + ".csv", "﻿" + usersToCsv(users), "text/csv");
    return base + ".csv";
  }

  // ==========================================================================
  // api: internal /api/v1 client, cookies, rate-limit detection
  // ==========================================================================

  // Instagram's public web app id. Required on the internal /api/v1 endpoints.
  const IG_APP_ID = "936619743392459";
  // A near-constant header IG's own web client sends. Harmless if ignored.
  const ASBD_ID = "129477";

  /** Raised on any rate-limit / challenge / spam signal. Callers must stop, not retry. */
  class RateLimitError extends Error {
    constructor(message) {
      super(message);
      this.name = "RateLimitError";
    }
  }

  /** Raised when cookies/session are missing or the server rejects the session. */
  class NotLoggedInError extends Error {
    constructor(message = "Not logged in to instagram.com in this tab.") {
      super(message);
      this.name = "NotLoggedInError";
    }
  }

  function getCookie(name) {
    const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&");
    const match = document.cookie.match(new RegExp("(?:^|;\\s*)" + escaped + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** My own numeric id, read from the ds_user_id cookie. */
  function getMyId() {
    const id = getCookie("ds_user_id");
    if (!id) throw new NotLoggedInError("Could not read the ds_user_id cookie — are you logged in?");
    return id;
  }

  /** CSRF token from the csrftoken cookie. */
  function getCsrfToken() {
    const token = getCookie("csrftoken");
    if (!token) throw new NotLoggedInError("Could not read the csrftoken cookie — are you logged in?");
    return token;
  }

  /** Headers every /api/v1 request needs. */
  function apiHeaders(extra) {
    const h = {
      "x-ig-app-id": IG_APP_ID,
      "x-csrftoken": getCsrfToken(),
      "x-asbd-id": ASBD_ID,
      "x-requested-with": "XMLHttpRequest",
    };
    return Object.assign(h, extra);
  }

  function looksLikeRateLimit(body) {
    if (!body || typeof body !== "object") return false;
    const message = String(body.message ?? "").toLowerCase();
    if (
      message.includes("feedback_required") ||
      message.includes("challenge_required") ||
      message.includes("please wait") ||
      message.includes("wait a few minutes") ||
      message.includes("try again later") ||
      message.includes("rate limit")
    ) {
      return true;
    }
    if (body.spam === true) return true;
    if (body.feedback_required === true) return true;
    if (body.status === "fail" && (body.feedback_required || body.spam)) return true;
    return false;
  }

  function rateLimitMessage(body) {
    return (
      body?.feedback_message ||
      body?.feedback_title ||
      body?.message ||
      "rate limit / challenge response"
    );
  }

  async function parseBody(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  }

  async function handleResponse(res) {
    const body = await parseBody(res);

    if (res.status === 429) {
      throw new RateLimitError("HTTP 429 (too many requests) — " + rateLimitMessage(body));
    }
    if (looksLikeRateLimit(body)) {
      throw new RateLimitError(rateLimitMessage(body));
    }
    if (res.status === 401 || res.status === 403) {
      // login_required is a session problem, not a rate limit.
      throw new NotLoggedInError(
        "HTTP " + res.status + " — " + (body?.message || "session/login required."),
      );
    }
    if (!res.ok) {
      const detail = body?.message || body?._raw || "";
      throw new Error("HTTP " + res.status + (detail ? ": " + String(detail).slice(0, 200) : ""));
    }
    return body;
  }

  async function igGet(path) {
    const res = await fetch(path, {
      method: "GET",
      credentials: "include",
      headers: apiHeaders(),
    });
    return handleResponse(res);
  }

  /**
   * Read the full following or followers list, paginating via next_max_id.
   * A short randomized delay is inserted between pages to stay gentle while reading.
   */
  async function getList(kind, myId, onProgress, signal) {
    const out = [];
    const seen = new Set();
    let maxId;

    for (;;) {
      if (signal?.aborted) throw new AbortError();
      const url =
        `/api/v1/friendships/${encodeURIComponent(myId)}/${kind}/?count=50` +
        (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
      const data = await igGet(url);

      const users = Array.isArray(data?.users) ? data.users : [];
      for (const u of users) {
        const pk = String(u.pk ?? u.pk_id ?? u.id ?? "");
        if (!pk || seen.has(pk)) continue;
        seen.add(pk);
        out.push({
          pk,
          username: String(u.username ?? ""),
          full_name: u.full_name,
          is_private: u.is_private,
        });
      }
      onProgress?.(out.length);

      maxId = data?.next_max_id != null ? String(data.next_max_id) : undefined;
      if (!maxId) break;
      await sleep(randomBetween(700, 1600), signal); // gentle paging
    }

    return out;
  }

  // ==========================================================================
  // domFallback: virtualized scroll-scrape (read-only)
  // ==========================================================================
  //
  // Used only if the internal API read path is blocked. Anchors on stable signals
  // (href shape, role) rather than obfuscated class names. The list modal is
  // virtualized: rows scrolled out of view are removed from the DOM, so we collect
  // usernames into a Set *as we scroll* and stop after a few scrolls with no new
  // names.

  // Top-level paths that are not user profiles.
  const RESERVED = new Set([
    "explore", "p", "reel", "reels", "direct", "stories", "story", "about",
    "accounts", "legal", "privacy", "terms", "developer", "developers", "api",
    "web", "your_activity", "tv", "ar", "challenge", "emails", "session",
    "push", "oauth", "graphql", "instagram", "help", "press", "blog",
  ]);

  function dialog() {
    return document.querySelector('div[role="dialog"][aria-modal="true"]');
  }

  /** Find the inner scrollable container of the modal (overflow-y auto/scroll). */
  function findScroller(root) {
    const divs = root.querySelectorAll("div");
    for (const el2 of divs) {
      const style = getComputedStyle(el2);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el2.scrollHeight > el2.clientHeight + 4
      ) {
        return el2;
      }
    }
    return null;
  }

  function usernameFromHref(href) {
    if (!href) return null;
    const m = href.match(/^\/([^/]+)\/$/);
    if (!m) return null;
    const name = m[1].toLowerCase();
    if (RESERVED.has(name)) return null;
    return name;
  }

  function collectUsernames(root, into) {
    const links = root.querySelectorAll('a[role="link"][href^="/"]');
    for (const a of links) {
      const name = usernameFromHref(a.getAttribute("href"));
      if (name) into.add(name);
    }
  }

  /**
   * Scrape every username from the currently open following/followers modal.
   * The caller must open the modal first. Returns lowercased usernames.
   */
  async function scrapeOpenModal(onProgress, signal) {
    const root = dialog();
    if (!root) {
      throw new Error("No open dialog found — open your Following or Followers list first.");
    }
    const scroller = findScroller(root);
    if (!scroller) {
      throw new Error("Could not find the scroll container inside the modal.");
    }

    const seen = new Set();
    let staleScrolls = 0;
    while (staleScrolls < 3) {
      if (signal?.aborted) throw new AbortError();
      collectUsernames(root, seen);
      const before = seen.size;
      scroller.scrollTo({ top: scroller.scrollHeight });
      await sleep(randomBetween(700, 1300), signal);
      collectUsernames(root, seen);
      onProgress?.(seen.size);
      if (seen.size === before) staleScrolls++;
      else staleScrolls = 0;
    }
    return [...seen];
  }

  // ==========================================================================
  // ui: shadow-DOM panel
  // ==========================================================================

  const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }

.wrap {
  /* ---- light theme (default) ---- */
  --bg: #ffffff; --header-bg: #ffffff; --text: #16181c; --muted: #6b7280;
  --border: #e4e7eb; --row-border: #eef0f2; --input-bg: #f4f6f8; --hover: #eef1f4;
  --ghost-bg: #eef1f4; --ghost-text: #16181c; --link: #1877f2;
  --badge-text: #6b7280; --shadow: 0 16px 48px rgba(0,0,0,.18);
  --ok: #178a4e; --warn: #b26b00; --err: #d83a3a;

  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  width: 380px; max-height: 86vh; display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 16px; box-shadow: var(--shadow); font-size: 13px; overflow: hidden;
}
.wrap.dark {
  --bg: #0f1115; --header-bg: #14161b; --text: #eef0f3; --muted: #8b9099;
  --border: #23262d; --row-border: #181b21; --input-bg: #0c0e12; --hover: #20242b;
  --ghost-bg: #20242b; --ghost-text: #c7ccd4; --link: #7fb6ff;
  --badge-text: #8b9099; --shadow: 0 20px 60px rgba(0,0,0,.55);
  --ok: #6ee787; --warn: #f0c14b; --err: #ff7a7a;
}
.wrap.collapsed { width: auto; }
.wrap.collapsed .body { display: none; }

header {
  display: flex; align-items: center; gap: 10px; padding: 13px 14px;
  background: var(--header-bg); border-bottom: 1px solid var(--border);
  cursor: grab; user-select: none; touch-action: none;
}
header:active { cursor: grabbing; }
header .logo { display: grid; place-items: center; flex: none; color: #d62976; }
header .logo svg { display: block; }
header .title { font-weight: 700; flex: 1; letter-spacing: .2px; }
header .title .ver { font-weight: 600; font-size: 10px; color: var(--muted); letter-spacing: .02em; }
header .icon-btn { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 4px 8px; border-radius: 8px; }
header .icon-btn:hover { background: var(--hover); color: var(--text); }

.body { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 13px; flex: 1 1 auto; min-height: 0; }

/* Visible thin scrollbars so it's obvious the panel scrolls (Windows hides them by default). */
.body::-webkit-scrollbar, .cands::-webkit-scrollbar, .log::-webkit-scrollbar { width: 9px; height: 9px; }
.body::-webkit-scrollbar-track, .cands::-webkit-scrollbar-track, .log::-webkit-scrollbar-track { background: transparent; }
.body::-webkit-scrollbar-thumb, .cands::-webkit-scrollbar-thumb, .log::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }

.step { display: flex; align-items: center; gap: 8px; }
.step .n { width: 19px; height: 19px; border-radius: 50%; background: var(--ghost-bg); color: var(--muted); font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: none; }
.t { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }

.btn { border: 0; border-radius: 10px; padding: 11px 14px; cursor: pointer; font-weight: 700; font-size: 13px; background: var(--ghost-bg); color: var(--ghost-text); transition: filter .15s, opacity .15s; }
.btn:hover:not(:disabled) { filter: brightness(.97); }
.wrap.dark .btn:hover:not(:disabled) { filter: brightness(1.15); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.block { width: 100%; }
.btn.accent { background: linear-gradient(45deg,#fa7e1e,#d62976,#962fbf); color: #fff; }
.btn.ghost { background: var(--ghost-bg); color: var(--ghost-text); }
.btn.tiny { padding: 6px 10px; font-size: 11px; border-radius: 8px; font-weight: 600; }

.hint { font-size: 12px; color: var(--muted); line-height: 1.45; }
.status { font-size: 12px; color: var(--muted); min-height: 16px; }
.actions { display: flex; gap: 8px; }
.spread { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

.cands { border: 1px solid var(--border); border-radius: 12px; min-height: 120px; max-height: 240px; overflow-y: auto; background: var(--input-bg); flex-shrink: 4; }
.cand { display: flex; align-items: center; gap: 10px; padding: 8px 11px; border-bottom: 1px solid var(--row-border); }
.cand:last-child { border-bottom: 0; }
.cand a { color: var(--link); text-decoration: none; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.cand a:hover { text-decoration: underline; }
.cand .badge { font-size: 11px; color: var(--badge-text); }
.empty { padding: 16px; text-align: center; color: var(--muted); }

details { border: 1px solid var(--border); border-radius: 12px; background: var(--input-bg); }
details > summary { list-style: none; cursor: pointer; padding: 11px 12px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; justify-content: space-between; }
details > summary::-webkit-details-marker { display: none; }
details > summary::after { content: "▸"; color: var(--muted); }
details[open] > summary::after { content: "▾"; }
details > .content { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 11px; }

select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; font-weight: 600; cursor: pointer; }

.log { background: var(--input-bg); border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; height: 104px; flex: none; overflow-y: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--text); }
.log .ts { color: var(--muted); opacity: .75; }
.log .info { color: var(--text); }
.log .warn { color: var(--warn); }
.log .error { color: var(--err); }
.log .success { color: var(--ok); }
.muted { color: var(--muted); }
.small { font-size: 11px; }
`;

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  class Panel {
    constructor(hooks) {
      this.hooks = hooks;
      this.lastCandidates = [];

      const host = el("div", { id: "ig-nmc-host" });
      document.body.appendChild(host);
      this.root = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = STYLE;
      this.root.appendChild(style);
      this.root.appendChild(this.buildUI());
      this.wire();
      this.applyTheme(gmGet(THEME_KEY, "light")); // default: light
      this.makeDraggable();
    }

    applyTheme(theme) {
      this.theme = theme === "dark" ? "dark" : "light";
      this.$(".wrap").classList.toggle("dark", this.theme === "dark");
      this.$("#themeBtn").textContent = this.theme === "dark" ? "☀" : "🌙";
      this.$("#themeBtn").title = this.theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      gmSet(THEME_KEY, this.theme);
    }

    toggleTheme() {
      this.applyTheme(this.theme === "dark" ? "light" : "dark");
    }

    /**
     * Drag the whole panel by its header. Switches from the default right/bottom
     * anchor to absolute left/top on first drag, clamps to the viewport, and
     * remembers the position. Clicks on the header buttons don't start a drag.
     */
    makeDraggable() {
      const wrap = this.$(".wrap");
      const header = this.root.querySelector("header");
      let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

      const moveTo = (left, top) => {
        const maxLeft = Math.max(0, window.innerWidth - wrap.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - 44); // keep the header grabbable
        left = Math.max(0, Math.min(left, maxLeft));
        top = Math.max(0, Math.min(top, maxTop));
        wrap.style.left = left + "px";
        wrap.style.top = top + "px";
        wrap.style.right = "auto";
        wrap.style.bottom = "auto";
        return { left, top };
      };

      header.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".icon-btn")) return; // let the buttons work
        const rect = wrap.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        dragging = true;
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      header.addEventListener("pointermove", (e) => {
        if (dragging) moveTo(startLeft + (e.clientX - startX), startTop + (e.clientY - startY));
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        gmSet("panelPos", { left: parseFloat(wrap.style.left) || 0, top: parseFloat(wrap.style.top) || 0 });
      };
      header.addEventListener("pointerup", end);
      header.addEventListener("pointercancel", end);

      // Restore a saved position (deferred a frame so offsetWidth is correct,
      // and re-clamped in case the window is now smaller).
      const saved = gmGet("panelPos", null);
      if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
        requestAnimationFrame(() => moveTo(saved.left, saved.top));
      }
    }

    $(selector) {
      const node = this.root.querySelector(selector);
      if (!node) throw new Error("Missing UI element: " + selector);
      return node;
    }

    buildUI() {
      const wrap = el("div", { class: "wrap" });
      wrap.innerHTML = `
      <header>
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        </span>
        <span class="title">Non-Mutual Detector <span class="ver">v2.0.0</span></span>
        <button class="icon-btn" id="themeBtn" title="Toggle light / dark">🌙</button>
        <button class="icon-btn" id="minBtn" title="Minimize">–</button>
      </header>
      <div class="body">

        <div class="step"><span class="n">1</span><span class="t">Find non-mutuals</span></div>
        <button class="btn accent block" id="loadBtn">Load non-mutuals</button>
        <div class="hint">Scans who you follow that don't follow you back. Reads only — changes nothing.</div>

        <div class="spread">
          <span class="step"><span class="n">2</span><span class="t" id="candCount">No list loaded yet</span></span>
        </div>
        <div class="cands" id="cands"><div class="empty">Press “Load non-mutuals” to begin.</div></div>
        <div class="status" id="status">Idle.</div>

        <div class="spread" style="margin-top:4px">
          <span class="t">Export lists</span>
          <select id="exportFormat" title="File format">
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
            <option value="txt">TXT</option>
          </select>
        </div>
        <div class="actions">
          <button class="btn ghost tiny" id="expNonMutuals">Non-mutuals</button>
          <button class="btn ghost tiny" id="expFollowing">Following</button>
          <button class="btn ghost tiny" id="expFollowers">Followers</button>
        </div>
        <div class="hint">Saves the loaded lists to a file on your device (no upload). Run Step 1 first. “Non-mutuals” = everyone you follow who doesn't follow you back.</div>

        <details id="domWrap">
          <summary>DOM fallback (only if API blocked)</summary>
          <div class="content">
            <div class="hint">Open your Following/Followers list in a modal, then scrape each one:</div>
            <div class="actions">
              <button class="btn ghost tiny" id="scrapeFollowingBtn">Scrape Following</button>
              <button class="btn ghost tiny" id="scrapeFollowersBtn">Scrape Followers</button>
            </div>
            <div class="hint">The API path is preferred — it's more reliable and includes the numeric ids in exports. Scraped lists only have usernames.</div>
          </div>
        </details>

        <div class="spread">
          <span class="t">Activity log</span>
          <button class="btn ghost tiny" id="clearLog">Clear</button>
        </div>
        <div class="log" id="log"></div>
      </div>
    `;
      return wrap;
    }

    wire() {
      this.$("#minBtn").addEventListener("click", () => {
        const collapsed = this.$(".wrap").classList.toggle("collapsed");
        this.$("#minBtn").textContent = collapsed ? "+" : "–";
      });
      this.$("#themeBtn").addEventListener("click", () => this.toggleTheme());

      this.$("#loadBtn").addEventListener("click", () => this.hooks.onLoad());
      this.$("#scrapeFollowingBtn").addEventListener("click", () => this.hooks.onScrapeFollowing());
      this.$("#scrapeFollowersBtn").addEventListener("click", () => this.hooks.onScrapeFollowers());

      this.$("#expNonMutuals").addEventListener("click", () => this.hooks.onExport("nonmutuals", this.getExportFormat()));
      this.$("#expFollowing").addEventListener("click", () => this.hooks.onExport("following", this.getExportFormat()));
      this.$("#expFollowers").addEventListener("click", () => this.hooks.onExport("followers", this.getExportFormat()));

      this.$("#clearLog").addEventListener("click", () => (this.$("#log").innerHTML = ""));
    }

    getExportFormat() {
      const v = this.$("#exportFormat").value;
      return v === "json" || v === "txt" ? v : "csv";
    }

    /** The full list of non-mutuals currently shown (what "Export → Non-mutuals" saves). */
    getAllCandidates() {
      return this.lastCandidates.slice();
    }

    // ---- Candidates (read-only list) ----------------------------------------

    setCandidates(users) {
      this.lastCandidates = Array.isArray(users) ? users.slice() : [];
      const container = this.$("#cands");
      container.innerHTML = "";
      if (this.lastCandidates.length === 0) {
        container.innerHTML = `<div class="empty">No non-mutuals found 🎉</div>`;
      } else {
        for (const user of this.lastCandidates) {
          const row = el("div", { class: "cand" });
          const link = el("a", {
            href: `/${user.username}/`,
            target: "_blank",
            rel: "noopener noreferrer",
          }, "@" + user.username);
          row.appendChild(link);
          if (user.is_private) row.appendChild(el("span", { class: "badge" }, "🔒"));
          container.appendChild(row);
        }
      }
      this.updateCount();
    }

    /** Recompute the "N non-mutuals found" counter. */
    updateCount() {
      const total = this.lastCandidates.length;
      this.$("#candCount").textContent = `${total} non-mutual${total === 1 ? "" : "s"} found`;
    }

    // ---- Status / log -------------------------------------------------------

    setStatus(text) {
      this.$("#status").textContent = text;
    }

    log(message, level = "info") {
      const logEl = this.$("#log");
      const line = el("div");
      const ts = new Date().toLocaleTimeString();
      const tsSpan = el("span", { class: "ts" }, `[${ts}] `);
      const msgSpan = el("span", { class: level }, message);
      line.appendChild(tsSpan);
      line.appendChild(msgSpan);
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  // ==========================================================================
  // main: wire UI <-> API
  // ==========================================================================

  // In-memory snapshots of the two lists.
  let following = [];
  let followers = [];

  function recompute(panel) {
    if (following.length === 0 && followers.length === 0) return;
    const candidates = computeNonMutuals(following, followers);
    panel.setCandidates(candidates);
    panel.log(
      `Non-mutuals (following − followers) = ${candidates.length}` +
        ` (following ${following.length}, followers ${followers.length}).`,
      "success",
    );
  }

  function reportError(panel, err) {
    if (err instanceof AbortError) {
      panel.log("Stopped.", "warn");
    } else if (err instanceof RateLimitError) {
      panel.log("⛔ Rate limit / challenge while reading: " + err.message + " — stopped.", "error");
    } else if (err instanceof NotLoggedInError) {
      panel.log("Not logged in: " + err.message, "error");
    } else {
      panel.log("Error: " + err.message, "error");
    }
  }

  async function loadListsViaApi(panel) {
    try {
      const myId = getMyId();
      panel.log("Reading following via internal API…");
      following = await getList("following", myId, (n) => panel.setStatus(`Following: ${n}…`));
      panel.log(`Following: ${following.length}`, "success");

      panel.log("Reading followers via internal API…");
      followers = await getList("followers", myId, (n) => panel.setStatus(`Followers: ${n}…`));
      panel.log(`Followers: ${followers.length}`, "success");

      panel.setStatus("Idle.");
      recompute(panel);
    } catch (err) {
      reportError(panel, err);
      if (!(err instanceof AbortError)) {
        panel.log("Tip: if the API is blocked, expand “DOM fallback” and scrape instead.", "warn");
      }
    }
  }

  async function scrapeInto(panel, kind) {
    try {
      panel.log(`DOM scrape: reading open ${kind} modal (scroll to bottom automatically)…`);
      const names = await scrapeOpenModal((n) => panel.setStatus(`${kind}: ${n}…`));
      const users = names.map((u) => ({ pk: "", username: u }));
      if (kind === "following") following = users;
      else followers = users;
      panel.log(`DOM ${kind}: ${users.length}`, "success");
      panel.setStatus("Idle.");
      recompute(panel);
    } catch (err) {
      reportError(panel, err);
    }
  }

  // Export one of the three loaded lists (following / followers / non-mutuals) to
  // a local file in the chosen format. Reads only the in-memory snapshots.
  function exportLists(panel, kind, format) {
    let users;
    const label = EXPORT_LABELS[kind] || kind;

    if (kind === "following") {
      users = following;
    } else if (kind === "followers") {
      users = followers;
    } else {
      // Export exactly what the candidate list shows (what the user sees).
      users = panel.getAllCandidates();
      // Non-blocking heads-up: if followers didn't load, the "non-mutuals" shown
      // are actually your whole following list, not true non-mutuals.
      if (users.length > 0 && following.length > 0 && followers.length === 0) {
        panel.log(
          "Note: followers list is empty — re-run “Load non-mutuals” so these are true non-mutuals, not just everyone you follow.",
          "warn",
        );
      }
    }

    if (!users || users.length === 0) {
      panel.log(`Nothing to export for ${label} — click “Load non-mutuals” (Step 1) first.`, "warn");
      return;
    }

    try {
      const filename = exportUsers(kind, users, format);
      panel.log(`Exported ${users.length} ${label} → ${filename}`, "success");
    } catch (err) {
      panel.log(`Export failed: ${err.message}`, "error");
    }
  }

  function main() {
    const panel = new Panel({
      onLoad: () => void loadListsViaApi(panel),
      onScrapeFollowing: () => void scrapeInto(panel, "following"),
      onScrapeFollowers: () => void scrapeInto(panel, "followers"),
      onExport: (kind, format) => exportLists(panel, kind, format),
    });

    panel.log("Ready. Step 1: “Load non-mutuals”. Then review the list, or export it.");
    panel.log("Tip: after loading, use “Export lists” to save your following / followers / non-mutuals (CSV/JSON/TXT).");
    panel.log("Read-only — it reads your lists on instagram.com using your existing session and never unfollows or changes anything.", "info");
  }

  // Wait for document.body before injecting (run-at document-idle usually covers this).
  if (document.body) {
    main();
  } else {
    window.addEventListener("DOMContentLoaded", main, { once: true });
  }
})();
