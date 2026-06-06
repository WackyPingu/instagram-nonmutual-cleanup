// ==UserScript==
// @name         Instagram Non-Mutual Cleanup
// @namespace    https://local/instagram-nonmutual-cleanup
// @version      1.3.2
// @description  Unfollow Instagram accounts that don't follow you back, and export your following / followers / non-mutuals to CSV, JSON, or TXT. Same-origin only, no third parties, gentle throttling, light/dark UI.
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

// Single self-contained userscript, everything inlined in one IIFE. Gentle by
// default: batches of 7, 40-90s jittered per unfollow, ~4min batch pause, daily
// cap 80, speed presets, an explicit confirm before unfollowing, stop-on-ratelimit
// (no retry), and abort/stop control. Light/dark theme (defaults to light). Every
// request stays same-origin to instagram.com; no credentials are ever requested.
// The loaded following / followers / non-mutual lists can also be exported to
// CSV / JSON / TXT — built in-page and saved locally, nothing is uploaded.

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

  /**
   * Like sleep(), but calls onTick(remainingSeconds, totalSeconds) about once a
   * second so the UI can show a live countdown. Still fully abortable.
   */
  async function countdownSleep(ms, signal, onTick) {
    const totalSec = Math.max(1, Math.round(ms / 1000));
    const end = Date.now() + ms;
    for (;;) {
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      onTick(Math.ceil(remaining / 1000), totalSec);
      await sleep(Math.min(1000, remaining), signal);
    }
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
   * entries (so they keep their numeric pk for the API unfollow path).
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
  // config: defaults, persistence, daily cap tracking
  // ==========================================================================

  const DEFAULT_CONFIG = {
    batchSize: 7,
    minDelayMs: 40_000,
    maxDelayMs: 90_000,
    batchPauseMs: 240_000,
    dailyCap: 80,
  };

  const CONFIG_KEY = "config";
  const DAILY_KEY = "daily";
  const THEME_KEY = "theme";

  function loadConfig() {
    const stored = gmGet(CONFIG_KEY, {});
    const merged = { ...DEFAULT_CONFIG, ...stored };
    // Sanitize: enforce sane numeric bounds.
    if (!(merged.minDelayMs >= 0)) merged.minDelayMs = DEFAULT_CONFIG.minDelayMs;
    if (!(merged.maxDelayMs >= merged.minDelayMs)) merged.maxDelayMs = Math.max(merged.minDelayMs, DEFAULT_CONFIG.maxDelayMs);
    if (!(merged.batchSize >= 1)) merged.batchSize = DEFAULT_CONFIG.batchSize;
    if (!(merged.batchPauseMs >= 0)) merged.batchPauseMs = DEFAULT_CONFIG.batchPauseMs;
    if (!(merged.dailyCap >= 0)) merged.dailyCap = DEFAULT_CONFIG.dailyCap;
    return merged;
  }

  function saveConfig(config) {
    gmSet(CONFIG_KEY, config);
  }

  function todayKey() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  /** Real unfollows performed today (resets automatically on date change). */
  function getDailyCount() {
    const state = gmGet(DAILY_KEY, { date: todayKey(), count: 0 });
    return state.date === todayKey() ? state.count : 0;
  }

  /** Increment today's counter by `n` and return the new total. */
  function addDailyCount(n) {
    const next = getDailyCount() + n;
    gmSet(DAILY_KEY, { date: todayKey(), count: next });
    return next;
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
    downloadFile(base + ".csv", "\uFEFF" + usersToCsv(users), "text/csv");
    return base + ".csv";
  }

  // ==========================================================================
  // api: internal /api/v1 client, cookies, rate-limit detection
  // ==========================================================================

  // Instagram's public web app id. Required on the internal /api/v1 endpoints.
  const IG_APP_ID = "936619743392459";
  // A near-constant header IG's own web client sends. Harmless if ignored.
  const ASBD_ID = "129477";

  // IG's web client gets an "X-IG-WWW-Claim" value from the `x-ig-set-www-claim`
  // response header and must echo it back on later (esp. write) requests.
  // Read calls populate this; the unfollow POST then sends it. Missing it is a
  // common cause of 403s on writes even when GET reads succeed.
  let wwwClaim = null;

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

  /** Headers every /api/v1 request needs, plus the cached www-claim once known. */
  function apiHeaders(extra) {
    const h = {
      "x-ig-app-id": IG_APP_ID,
      "x-csrftoken": getCsrfToken(),
      "x-asbd-id": ASBD_ID,
      "x-requested-with": "XMLHttpRequest",
    };
    if (wwwClaim) h["x-ig-www-claim"] = wwwClaim;
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
    // Cache the www-claim so later (write) requests can echo it back.
    const claim = res.headers.get("x-ig-set-www-claim");
    if (claim) wwwClaim = claim;

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

  /** Unfollow a single account by numeric pk via the internal destroy endpoint. */
  async function unfollow(pk, signal) {
    if (signal?.aborted) throw new AbortError();
    const res = await fetch(`/api/v1/friendships/destroy/${encodeURIComponent(pk)}/`, {
      method: "POST",
      credentials: "include",
      headers: apiHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: `user_id=${encodeURIComponent(pk)}&container_module=profile`,
    });
    const body = await handleResponse(res);
    if (body?.status && body.status !== "ok") {
      throw new Error("Unfollow failed: " + (body.message || JSON.stringify(body).slice(0, 200)));
    }
  }

  /** Warm up the www-claim with a harmless GET if we don't have it yet. */
  async function ensureWwwClaim() {
    if (wwwClaim) return;
    try {
      await igGet(`/api/v1/users/${encodeURIComponent(getMyId())}/info/`);
    } catch {
      /* claim is captured in handleResponse even if the body errors */
    }
  }

  /**
   * Diagnostic: attempt ONE real unfollow and return the raw HTTP status + body
   * text WITHOUT throwing on HTTP errors, so the exact response can be shown in
   * the log. (Network/CORS failures still reject.)
   */
  async function probeUnfollow(pk) {
    const res = await fetch(`/api/v1/friendships/destroy/${encodeURIComponent(pk)}/`, {
      method: "POST",
      credentials: "include",
      headers: apiHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: `user_id=${encodeURIComponent(pk)}&container_module=profile`,
    });
    const claim = res.headers.get("x-ig-set-www-claim");
    if (claim) wwwClaim = claim;
    return { status: res.status, body: await res.text() };
  }

  // ==========================================================================
  // domFallback: virtualized scroll-scrape + two-step DOM unfollow
  // ==========================================================================
  //
  // Used only if the internal API path is blocked. Anchors on stable signals
  // (href shape, role, button text) rather than obfuscated class names. The list
  // modal is virtualized: rows scrolled out of view are removed from the DOM, so
  // we collect usernames into a Set *as we scroll* and stop after a few scrolls
  // with no new names.

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

  function clickableWithText(scope, text) {
    const target = text.trim().toLowerCase();
    const nodes = scope.querySelectorAll('button, [role="button"]');
    for (const el2 of nodes) {
      if ((el2.textContent ?? "").trim().toLowerCase() === target) return el2;
    }
    return null;
  }

  /** Walk up from a profile link to find the row's "Following" button. */
  function findFollowingButton(link) {
    let node = link;
    for (let depth = 0; depth < 8 && node; depth++) {
      const btn = clickableWithText(node, "following");
      if (btn) return btn;
      node = node.parentElement;
    }
    return null;
  }

  async function findRowButton(root, scroller, username, signal) {
    const target = `/${username.toLowerCase()}/`;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (signal?.aborted) throw new AbortError();
      const link = [...root.querySelectorAll('a[role="link"][href^="/"]')].find(
        (a) => (a.getAttribute("href") ?? "").toLowerCase() === target,
      );
      if (link) {
        const btn = findFollowingButton(link);
        if (btn) {
          btn.scrollIntoView({ block: "center" });
          return btn;
        }
      }
      if (scroller) scroller.scrollBy({ top: scroller.clientHeight * 0.8 });
      await sleep(randomBetween(500, 900), signal);
    }
    return null;
  }

  async function waitForConfirmButton(signal) {
    for (let i = 0; i < 40; i++) {
      if (signal?.aborted) throw new AbortError();
      // The confirm dialog is a separate role="dialog" (not aria-modal here).
      for (const d of document.querySelectorAll('div[role="dialog"]')) {
        const btn = clickableWithText(d, "unfollow");
        if (btn) return btn;
      }
      await sleep(150, signal);
    }
    throw new Error("Unfollow confirmation dialog did not appear.");
  }

  /**
   * Two-step DOM unfollow within the open Following modal:
   *   1) scroll the row into view, click its "Following" button
   *   2) click "Unfollow" in the confirmation dialog
   */
  async function domUnfollow(username, signal) {
    const root = dialog();
    if (!root) throw new Error("Following modal is not open.");
    const scroller = findScroller(root);

    const followingBtn = await findRowButton(root, scroller, username, signal);
    if (!followingBtn) {
      throw new Error(`Could not find the "Following" button for @${username}.`);
    }
    followingBtn.click();

    const confirmBtn = await waitForConfirmButton(signal);
    confirmBtn.click();
    await sleep(randomBetween(800, 1500), signal);
  }

  // ==========================================================================
  // runner: throttled unfollow loop (abort, daily cap, batches)
  // ==========================================================================

  /**
   * Process the selected candidates one at a time with gentle, randomized
   * throttling. Stops immediately on Stop (abort) or any rate-limit/challenge.
   */
  async function runUnfollow(ctx) {
    const { candidates, config, signal, mode } = ctx;
    const summary = {
      unfollowed: 0,
      errors: 0,
      remaining: candidates.length,
      stoppedReason: "completed",
    };

    let inBatch = 0;
    let consecutiveErrors = 0;
    let dailyUsed = getDailyCount();

    for (let i = 0; i < candidates.length; i++) {
      const user = candidates[i];

      if (signal.aborted) {
        summary.stoppedReason = "stopped by user";
        break;
      }
      if (dailyUsed >= config.dailyCap) {
        summary.stoppedReason = `daily cap (${config.dailyCap}) reached`;
        ctx.log("⛔ " + summary.stoppedReason + " — stopping for today.", "warn");
        break;
      }

      ctx.setStatus(`(${i + 1}/${candidates.length}) @${user.username}`);
      ctx.clearCountdown();

      try {
        if (mode === "api") {
          if (!user.pk) throw new Error("missing pk (re-load lists via the API to get it)");
          await unfollow(user.pk, signal);
        } else {
          await domUnfollow(user.username, signal);
        }
        dailyUsed = addDailyCount(1);
        summary.unfollowed++;
        summary.remaining--;
        ctx.log(`✓ Unfollowed @${user.username} — today ${dailyUsed}/${config.dailyCap}`, "success");
        ctx.markDone(user, "unfollowed");
        inBatch++;
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof AbortError) {
          summary.stoppedReason = "stopped by user";
          break;
        }
        if (err instanceof RateLimitError) {
          summary.stoppedReason = "rate limit / challenge: " + err.message;
          ctx.log("⛔ " + summary.stoppedReason + " — stopping immediately, no retry.", "error");
          break;
        }
        // A single non-fatal error: record it and move on after a short pause.
        summary.errors++;
        summary.remaining--;
        consecutiveErrors++;
        ctx.log(`✗ Error on @${user.username}: ${err.message}`, "error");
        ctx.markDone(user, "error");
        // If the very first ones all fail, something is wrong for ALL of them
        // (bad endpoint/headers/session) — stop instead of hammering the API.
        if (consecutiveErrors >= 3) {
          summary.stoppedReason = "stopped after 3 errors in a row — see log";
          ctx.log("⛔ " + summary.stoppedReason + ". Nothing else will be attempted.", "error");
          break;
        }
        await sleep(randomBetween(2000, 4000), signal).catch(() => {});
        continue;
      }

      // --- Throttle before the next account (not after the last) -------------
      if (i < candidates.length - 1) {
        try {
          if (inBatch >= config.batchSize) {
            inBatch = 0;
            // Jitter the batch pause ±15% so it's never a fixed interval.
            const pause = randomBetween(
              Math.round(config.batchPauseMs * 0.85),
              Math.round(config.batchPauseMs * 1.15),
            );
            ctx.log(`Batch of ${config.batchSize} done — resting ~${Math.round(pause / 1000)}s.`);
            ctx.setStatus("Resting between batches…");
            await countdownSleep(pause, signal, (rem, tot) => ctx.setCountdown(rem, tot, "Next batch in"));
          } else {
            const delay = randomBetween(config.minDelayMs, config.maxDelayMs);
            ctx.log(`Waiting ${Math.round(delay / 1000)}s before next…`);
            ctx.setStatus("Pacing between unfollows…");
            await countdownSleep(delay, signal, (rem, tot) => ctx.setCountdown(rem, tot, "Next unfollow in"));
          }
          ctx.clearCountdown();
        } catch (err) {
          ctx.clearCountdown();
          if (err instanceof AbortError) {
            summary.stoppedReason = "stopped by user";
            break;
          }
          throw err;
        }
      }
    }

    return summary;
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
  --danger: #ed4956; --ok: #178a4e; --warn: #b26b00; --err: #d83a3a;

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
  --danger: #d8392b; --ok: #6ee787; --warn: #f0c14b; --err: #ff7a7a;
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
header .icon-btn { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 4px 8px; border-radius: 8px; }
header .icon-btn:hover { background: var(--hover); color: var(--text); }

.body { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 13px; flex: 1 1 auto; min-height: 0; }

.step { display: flex; align-items: center; gap: 8px; }
.step .n { width: 19px; height: 19px; border-radius: 50%; background: var(--ghost-bg); color: var(--muted); font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: none; }
.t { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }

.btn { border: 0; border-radius: 10px; padding: 11px 14px; cursor: pointer; font-weight: 700; font-size: 13px; background: var(--ghost-bg); color: var(--ghost-text); transition: filter .15s, opacity .15s; }
.btn:hover:not(:disabled) { filter: brightness(.97); }
.wrap.dark .btn:hover:not(:disabled) { filter: brightness(1.15); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.block { width: 100%; }
.btn.accent { background: linear-gradient(45deg,#fa7e1e,#d62976,#962fbf); color: #fff; }
.btn.danger { background: var(--danger); color: #fff; }
.btn.ghost { background: var(--ghost-bg); color: var(--ghost-text); }
.btn.tiny { padding: 6px 10px; font-size: 11px; border-radius: 8px; font-weight: 600; }

.hint { font-size: 12px; color: var(--muted); line-height: 1.45; }
.status { font-size: 12px; color: var(--muted); min-height: 16px; }
.actions { display: flex; gap: 8px; }
.spread { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

.countdown { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--input-bg); }
.countdown[hidden] { display: none; }
.cd-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.cd-row .cd-label { color: var(--muted); font-weight: 600; }
.cd-row .cd-time { font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; color: var(--text); }
.cd-bar { height: 6px; border-radius: 999px; background: var(--ghost-bg); overflow: hidden; }
.cd-fill { height: 100%; width: 100%; border-radius: 999px; background: linear-gradient(45deg,#fa7e1e,#d62976,#962fbf); transition: width .25s linear; }

.cands { border: 1px solid var(--border); border-radius: 12px; max-height: 240px; overflow-y: auto; background: var(--input-bg); }
.cand { display: flex; align-items: center; gap: 10px; padding: 8px 11px; border-bottom: 1px solid var(--row-border); }
.cand:last-child { border-bottom: 0; }
.cand input { width: 16px; height: 16px; accent-color: #d62976; flex: none; }
.cand a { color: var(--link); text-decoration: none; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.cand a:hover { text-decoration: underline; }
.cand .badge { font-size: 11px; color: var(--badge-text); }
.cand.done-unfollowed { opacity: .45; }
.cand.done-unfollowed a { text-decoration: line-through; color: var(--muted); }
.cand.done-error { background: rgba(216,57,43,.12); }
.empty { padding: 16px; text-align: center; color: var(--muted); }

details { border: 1px solid var(--border); border-radius: 12px; background: var(--input-bg); }
details > summary { list-style: none; cursor: pointer; padding: 11px 12px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; justify-content: space-between; }
details > summary::-webkit-details-marker { display: none; }
details > summary::after { content: "▸"; color: var(--muted); }
details[open] > summary::after { content: "▾"; }
details > .content { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 11px; }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field span { font-size: 11px; color: var(--muted); }
.field input { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px; font-size: 12px; }
select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; font-weight: 600; cursor: pointer; }

.log { background: var(--input-bg); border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; height: 128px; overflow-y: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--text); }
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

  function candidateKey(user) {
    return user.pk ? "pk:" + user.pk : "u:" + normalizeUsername(user.username);
  }

  class Panel {
    constructor(hooks) {
      this.hooks = hooks;
      this.candidateRows = new Map();
      this.lastCandidates = [];
      this.running = false;

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
        <span class="title">Non-Mutual Cleanup</span>
        <button class="icon-btn" id="themeBtn" title="Toggle light / dark">🌙</button>
        <button class="icon-btn" id="minBtn" title="Minimize">–</button>
      </header>
      <div class="body">

        <div class="step"><span class="n">1</span><span class="t">Find non-mutuals</span></div>
        <button class="btn accent block" id="loadBtn">Load non-mutuals</button>
        <div class="hint">Scans who you follow that don't follow you back. Reads only — changes nothing.</div>

        <div class="spread">
          <span class="step"><span class="n">2</span><span class="t" id="candCount">No list loaded yet</span></span>
          <span class="actions">
            <button class="btn ghost tiny" id="selAll">All</button>
            <button class="btn ghost tiny" id="selNone">None</button>
          </span>
        </div>
        <div class="cands" id="cands"><div class="empty">Press “Load non-mutuals” to begin.</div></div>

        <div class="actions">
          <button class="btn danger block" id="startBtn" disabled>Unfollow</button>
          <button class="btn ghost" id="stopBtn" disabled>Stop</button>
        </div>
        <div class="hint">Tick the accounts to remove, then click <strong>Unfollow</strong> (you'll confirm once). Removed one at a time with safe delays.</div>
        <div class="countdown" id="countdown" hidden>
          <div class="cd-row"><span class="cd-label" id="cdLabel">Next unfollow in</span><span class="cd-time" id="cdTime">—</span></div>
          <div class="cd-bar"><div class="cd-fill" id="cdFill"></div></div>
        </div>
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

        <details id="advanced">
          <summary>Advanced settings</summary>
          <div class="content">
            <div class="field"><span>Speed preset</span>
              <div class="actions">
                <button class="btn ghost tiny" data-speed="safe">Safe</button>
                <button class="btn ghost tiny" data-speed="medium">Medium</button>
                <button class="btn ghost tiny" data-speed="fast">Fast ⚠</button>
              </div>
            </div>
            <div class="hint">Faster = higher chance Instagram temporarily blocks unfollows. “Safe” (default) is recommended.</div>
            <div class="grid">
              <label class="field"><span>Batch size</span><input type="number" id="batchSize" min="1" /></label>
              <label class="field"><span>Daily cap</span><input type="number" id="dailyCap" min="0" /></label>
              <label class="field"><span>Min delay (s)</span><input type="number" id="minDelay" min="0" /></label>
              <label class="field"><span>Max delay (s)</span><input type="number" id="maxDelay" min="0" /></label>
              <label class="field"><span>Batch pause (min)</span><input type="number" id="batchPause" min="0" step="0.5" /></label>
              <div class="field"><span>Unfollowed today</span><div id="dailyUsed" class="small">0 / 0</div></div>
            </div>
            <div class="spread">
              <button class="btn ghost tiny" id="saveCfgBtn">Save settings</button>
              <span class="muted small">saved on this device</span>
            </div>
            <div class="spread">
              <button class="btn ghost tiny" id="testBtn">Test 1 real unfollow</button>
              <span class="muted small">diagnoses the unfollow path</span>
            </div>
            <details id="domWrap">
              <summary>DOM fallback (only if API blocked)</summary>
              <div class="content">
                <label class="hint" style="display:flex;gap:7px;align-items:center;cursor:pointer">
                  <input type="checkbox" id="domMode" /> Use DOM mode (click-through, no API)
                </label>
                <div class="hint">Open your Following/Followers list in a modal, then scrape each one:</div>
                <div class="actions">
                  <button class="btn ghost tiny" id="scrapeFollowingBtn">Scrape Following</button>
                  <button class="btn ghost tiny" id="scrapeFollowersBtn">Scrape Followers</button>
                </div>
              </div>
            </details>
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
      this.$("#startBtn").addEventListener("click", () => this.hooks.onUnfollow());
      this.$("#stopBtn").addEventListener("click", () => this.hooks.onStop());
      this.$("#saveCfgBtn").addEventListener("click", () => this.hooks.onSaveConfig(this.getConfig()));
      this.$("#testBtn").addEventListener("click", () => this.hooks.onTest());
      this.$("#scrapeFollowingBtn").addEventListener("click", () => this.hooks.onScrapeFollowing());
      this.$("#scrapeFollowersBtn").addEventListener("click", () => this.hooks.onScrapeFollowers());

      this.$("#expNonMutuals").addEventListener("click", () => this.hooks.onExport("nonmutuals", this.getExportFormat()));
      this.$("#expFollowing").addEventListener("click", () => this.hooks.onExport("following", this.getExportFormat()));
      this.$("#expFollowers").addEventListener("click", () => this.hooks.onExport("followers", this.getExportFormat()));

      this.$("#selAll").addEventListener("click", () => this.setAllChecked(true));
      this.$("#selNone").addEventListener("click", () => this.setAllChecked(false));
      this.$("#clearLog").addEventListener("click", () => (this.$("#log").innerHTML = ""));

      this.root.querySelectorAll("[data-speed]").forEach((b) =>
        b.addEventListener("click", () => this.applyPreset(b.dataset.speed)),
      );

      // Keep the counter + buttons in sync as rows are checked / unchecked.
      this.$("#cands").addEventListener("change", () => this.refresh());
      this.refresh();
    }

    /** Fill the throttle fields from a named speed preset, then persist. */
    applyPreset(name) {
      const presets = {
        safe: { min: 40, max: 90, batch: 7, pause: 4, cap: 80 },
        medium: { min: 15, max: 30, batch: 10, pause: 2, cap: 120 },
        fast: { min: 7, max: 15, batch: 15, pause: 1, cap: 200 },
      };
      const p = presets[name];
      if (!p) return;
      this.$("#minDelay").value = String(p.min);
      this.$("#maxDelay").value = String(p.max);
      this.$("#batchSize").value = String(p.batch);
      this.$("#batchPause").value = String(p.pause);
      this.$("#dailyCap").value = String(p.cap);
      this.hooks.onSaveConfig(this.getConfig());
      this.log(
        `Speed preset “${name}”: ${p.min}-${p.max}s per unfollow, batches of ${p.batch}, ${p.pause}min rests.` +
          (name === "fast" ? " ⚠ higher risk of an Instagram block." : ""),
        name === "fast" ? "warn" : "info",
      );
    }

    // ---- Config get/set (UI fields use seconds / minutes for readability) ---

    getConfig() {
      const num = (sel, fallback) => {
        const v = parseFloat(this.$(sel).value);
        return Number.isFinite(v) && v >= 0 ? v : fallback;
      };
      let minDelayMs = Math.round(num("#minDelay", DEFAULT_CONFIG.minDelayMs / 1000) * 1000);
      let maxDelayMs = Math.round(num("#maxDelay", DEFAULT_CONFIG.maxDelayMs / 1000) * 1000);
      if (maxDelayMs < minDelayMs) [minDelayMs, maxDelayMs] = [maxDelayMs, minDelayMs];

      return {
        batchSize: Math.max(1, Math.round(num("#batchSize", DEFAULT_CONFIG.batchSize))),
        minDelayMs,
        maxDelayMs,
        batchPauseMs: Math.round(num("#batchPause", DEFAULT_CONFIG.batchPauseMs / 60000) * 60000),
        dailyCap: Math.round(num("#dailyCap", DEFAULT_CONFIG.dailyCap)),
      };
    }

    setConfig(config) {
      this.$("#batchSize").value = String(config.batchSize);
      this.$("#dailyCap").value = String(config.dailyCap);
      this.$("#minDelay").value = String(Math.round(config.minDelayMs / 1000));
      this.$("#maxDelay").value = String(Math.round(config.maxDelayMs / 1000));
      this.$("#batchPause").value = String(config.batchPauseMs / 60000);
      this.refresh();
    }

    getMode() {
      return this.$("#domMode").checked ? "dom" : "api";
    }

    getExportFormat() {
      const v = this.$("#exportFormat").value;
      return v === "json" || v === "txt" ? v : "csv";
    }

    /** The full list of non-mutuals currently shown (what "Export → Non-mutuals" saves). */
    getAllCandidates() {
      return this.lastCandidates.slice();
    }

    // ---- Candidates ---------------------------------------------------------

    setCandidates(users) {
      this.candidateRows.clear();
      this.lastCandidates = Array.isArray(users) ? users.slice() : [];
      const container = this.$("#cands");
      container.innerHTML = "";
      if (users.length === 0) {
        container.innerHTML = `<div class="empty">No non-mutuals found 🎉</div>`;
      } else {
        for (const user of users) {
          const row = el("label", { class: "cand" });
          const checkbox = el("input", { type: "checkbox" });
          checkbox.checked = true;
          const link = el("a", {
            href: `/${user.username}/`,
            target: "_blank",
            rel: "noopener noreferrer",
          }, "@" + user.username);
          row.appendChild(checkbox);
          row.appendChild(link);
          if (user.is_private) row.appendChild(el("span", { class: "badge" }, "🔒"));
          container.appendChild(row);
          this.candidateRows.set(candidateKey(user), { user, checkbox, row });
        }
      }
      this.refresh();
    }

    getSelectedCandidates() {
      const out = [];
      for (const { user, checkbox, row } of this.candidateRows.values()) {
        if (checkbox.checked && !row.classList.contains("done-unfollowed")) out.push(user);
      }
      return out;
    }

    markCandidate(user, status) {
      const entry = this.candidateRows.get(candidateKey(user));
      if (!entry) return;
      entry.row.classList.add("done-" + status);
      if (status === "unfollowed") {
        entry.checkbox.checked = false;
        entry.checkbox.disabled = true;
      }
      this.refresh();
    }

    setAllChecked(checked) {
      for (const { checkbox, row } of this.candidateRows.values()) {
        if (!row.classList.contains("done-unfollowed")) checkbox.checked = checked;
      }
      this.refresh();
    }

    /** Recompute the counter and the Unfollow button. */
    refresh() {
      const total = this.candidateRows.size;
      const selected = this.getSelectedCandidates().length;

      this.$("#candCount").textContent = total === 0 ? "No list loaded yet" : `${selected} selected of ${total}`;

      const start = this.$("#startBtn");
      start.disabled = this.running || total === 0 || selected === 0;
      start.textContent = selected ? `Unfollow ${selected}` : "Unfollow";
    }

    // ---- Status / log / running state ---------------------------------------

    setStatus(text) {
      this.$("#status").textContent = text;
    }

    /** Show/update the live countdown bar (remaining + total seconds). */
    setCountdown(remainingSec, totalSec, label) {
      this.$("#countdown").hidden = false;
      this.$("#cdLabel").textContent = label || "Next unfollow in";
      this.$("#cdTime").textContent = remainingSec + "s";
      const frac = totalSec > 0 ? Math.max(0, Math.min(1, remainingSec / totalSec)) : 0;
      this.$("#cdFill").style.width = frac * 100 + "%";
    }

    clearCountdown() {
      this.$("#countdown").hidden = true;
    }

    setDailyUsed(used, cap) {
      this.$("#dailyUsed").textContent = `${used} / ${cap}`;
    }

    setRunning(isRunning) {
      this.running = isRunning;
      this.$("#stopBtn").disabled = !isRunning;
      this.$("#loadBtn").disabled = isRunning;
      this.refresh(); // recomputes Start button enabled/label
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
  // main: wire UI <-> API <-> runner
  // ==========================================================================

  // In-memory snapshots of the two lists, plus the active run controller.
  let following = [];
  let followers = [];
  let abortController = null;
  let running = false;

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

  // Diagnostic: do ONE real unfollow on the first selected account and print the
  // exact HTTP status + body to the log.
  async function runTest(panel) {
    const target = panel.getSelectedCandidates()[0];
    if (!target) {
      panel.log("Test: select at least one account first (or click “Load non-mutuals”).", "warn");
      return;
    }
    if (!target.pk) {
      panel.log("Test: that account has no numeric id — load via API first.", "warn");
      return;
    }
    const ok = window.confirm(
      `TEST — really unfollow @${target.username} now?\n\n` +
        `This unfollows ONE account for real, to diagnose the unfollow path.`,
    );
    if (!ok) {
      panel.log("Test cancelled.", "warn");
      return;
    }
    try {
      panel.log("Test: warming up session token…");
      await ensureWwwClaim();
      panel.log(`Test: POST destroy @${target.username} (pk ${target.pk})…`);
      const { status, body } = await probeUnfollow(target.pk);
      const short = body.length > 400 ? body.slice(0, 400) + "…" : body;
      panel.log(`TEST RESULT: HTTP ${status} — ${short || "(empty body)"}`, status === 200 ? "success" : "error");
      if (status === 200 && /"status"\s*:\s*"ok"/.test(body)) {
        panel.markCandidate(target, "unfollowed");
        panel.log("✓ Unfollow WORKS! Tick the accounts you want gone and click the red “Unfollow” button.", "success");
      } else {
        panel.log("✗ Server did not return ok. Copy the “TEST RESULT” line above and send it to me.", "warn");
      }
    } catch (err) {
      panel.log(`TEST failed before a response (network/sandbox block): ${err.message}`, "error");
    }
  }

  async function start(panel) {
    if (running) return;
    const config = panel.getConfig();
    saveConfig(config);

    const selected = panel.getSelectedCandidates();
    if (selected.length === 0) {
      panel.log("No accounts selected — load the list and tick the ones to remove.", "warn");
      return;
    }

    const mode = panel.getMode();
    if (mode === "api" && selected.some((u) => !u.pk)) {
      panel.log(
        "Some selected candidates have no numeric id (DOM-scraped). Either switch on DOM mode " +
          "or re-load lists via the API first.",
        "warn",
      );
      return;
    }

    // Safety gate: an explicit confirmation before anything is unfollowed.
    const ok = window.confirm(
      `Unfollow ${selected.length} account(s)?\n\nThis cannot be undone.`,
    );
    if (!ok) {
      panel.log("Cancelled — nothing was changed.", "warn");
      return;
    }

    abortController = new AbortController();
    running = true;
    panel.setRunning(true);
    panel.log(`Unfollowing ${selected.length} account(s) — mode: ${mode}.`, "warn");

    try {
      const summary = await runUnfollow({
        candidates: selected,
        config,
        signal: abortController.signal,
        mode,
        log: (m, l) => panel.log(m, l),
        setStatus: (s) => panel.setStatus(s),
        setCountdown: (rem, tot, label) => panel.setCountdown(rem, tot, label),
        clearCountdown: () => panel.clearCountdown(),
        markDone: (u, s) => panel.markCandidate(u, s),
      });
      panel.log(
        `Done — unfollowed ${summary.unfollowed}, ` +
          `errors ${summary.errors}, remaining ${summary.remaining}. Reason: ${summary.stoppedReason}.`,
        "success",
      );
    } catch (err) {
      reportError(panel, err);
    } finally {
      running = false;
      abortController = null;
      panel.setRunning(false);
      panel.clearCountdown();
      panel.setStatus("Idle.");
      panel.setDailyUsed(getDailyCount(), config.dailyCap);
    }
  }

  function main() {
    const config = loadConfig();
    const panel = new Panel({
      onLoad: () => void loadListsViaApi(panel),
      onUnfollow: () => void start(panel),
      onStop: () => {
        abortController?.abort();
        panel.log("Stop requested…", "warn");
      },
      onSaveConfig: (cfg) => {
        saveConfig(cfg);
        panel.log("Settings saved.", "success");
      },
      onTest: () => void runTest(panel),
      onScrapeFollowing: () => void scrapeInto(panel, "following"),
      onScrapeFollowers: () => void scrapeInto(panel, "followers"),
      onExport: (kind, format) => exportLists(panel, kind, format),
    });

    panel.setConfig(config);
    panel.setDailyUsed(getDailyCount(), config.dailyCap);
    panel.log("Ready. Step 1: “Load non-mutuals”. Step 2: tick accounts, then “Unfollow”.");
    panel.log("Tip: after loading, use “Export lists” to save your following / followers / non-mutuals (CSV/JSON/TXT).");
    panel.log("This runs only on instagram.com using your existing session — no logins, no third parties.", "info");
  }

  // Wait for document.body before injecting (run-at document-idle usually covers this).
  if (document.body) {
    main();
  } else {
    window.addEventListener("DOMContentLoaded", main, { once: true });
  }
})();
