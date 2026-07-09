# Instagram Non-Mutual Detector (Tampermonkey userscript)

Detects accounts **you follow that don't follow you back**.
Runs entirely inside your already-logged-in `instagram.com` tab and reuses that
session. **Read-only — it never unfollows or changes anything.**

- ✅ Same-origin only — never asks for your username/password, never talks to any
  third-party service.
- ✅ **Read-only** — it loads your lists and shows the non-mutuals; it never modifies
  your account.
- ✅ **Detect who you unfollowed** since your last check — it keeps a private local
  snapshot of who you follow and shows what's gone next time.
- ✅ **Export** your following, followers, non-mutuals, or recently-unfollowed to
  **CSV / JSON / TXT** — built in-page and saved straight to your device, nothing uploaded.
- ✅ Gentle randomized paging while reading, so it stays light on the API.
- ✅ Clean **light / dark** UI (defaults to light); **drag the header** to move the panel
  (position is remembered).
- ✅ Stops immediately on any rate-limit / challenge / `feedback_required` signal.

> Reading your own following/followers via Instagram's internal web API is still
> automation and against IG's Terms of Service. This is for inspecting **your own**
> account. Keep it gentle. Use at your own risk.

## Deliverable

A single, self-contained plain-JavaScript userscript:

**`instagram-nonmutual-detector.user.js`**

No build step, no dependencies, no `@require`, nothing external — everything
(persistence, API client, set math, export, shadow-DOM UI, and the read-only DOM
fallback) is inlined in that one file.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. **One-click install** — open the raw script and Tampermonkey detects it and shows
   its install page; click **Install** there:

   👉 **[Install Instagram Non-Mutual Detector](https://github.com/WackyPingu/instagram-nonmutual-detector/raw/refs/heads/main/instagram-nonmutual-detector.user.js)**

   The script declares `@downloadURL` / `@updateURL`, so Tampermonkey will also offer
   **automatic updates** from this repo whenever `@version` is bumped.
3. Open / refresh `https://www.instagram.com/` while logged in. A panel appears in
   the bottom-right corner (drag its header to move it).

<details>
<summary>Manual install (if the one-click link doesn't trigger Tampermonkey)</summary>

- **Drag & drop:** drag `instagram-nonmutual-detector.user.js` onto the Tampermonkey
  dashboard, then click **Install**; or
- **Copy/paste:** open the Tampermonkey dashboard → **+** (Create a new script) →
  replace the template with the full contents of the file → **File ▸ Save**.

Tampermonkey reads the `// ==UserScript==` header automatically.

</details>

That's it — it's installable as-is.

## Usage

1. Click **Load non-mutuals**. It reads your full following + followers lists via the
   internal web API and logs the counts — verify they roughly match your profile
   header.
2. It computes **non-mutuals = following − followers** and lists them (each links to
   the profile; 🔒 marks private accounts). Nothing is changed — the list is just for
   review and export.
3. Use the **Export lists** row to save the list (see below).
4. Use the 🌙 / ☀ button in the header to switch **light / dark** mode (remembered).

### Detect who you unfollowed

Instagram has no "who did I unfollow?" endpoint, so the script keeps a private
snapshot of who you follow (stored locally with `GM_setValue`, never uploaded) each
time you **Load non-mutuals** via the API. The **next** load compares against it and,
if anything changed, shows a **Recently unfollowed** section — accounts you followed
at the last check but don't follow now (with a **since &lt;date&gt;** label and an
**Export this list** button).

- The **first** load just saves the baseline — there's nothing to compare yet.
- The baseline **rolls forward on every successful API load**, so the list always
  means "since you last checked."
- Only the **API** load path updates the snapshot; the DOM-scrape fallback can be
  partial, which would show false positives.

### Export your lists

After **Load non-mutuals** has read both lists, use the **Export lists** row:

- Pick a format — **CSV** (opens in Excel/Sheets), **JSON** (full data + metadata), or
  **TXT** (one username per line).
- Click **Non-mutuals**, **Following**, or **Followers**. The file downloads as
  `instagram-<list>-YYYY-MM-DD.<ext>`.

CSV/JSON include `username`, `full_name`, `is_private`, the numeric `pk`, and the
`profile_url`. Exporting is read-only and fully local — the file is built in your
browser; nothing is sent anywhere. (Lists scraped via the DOM fallback only have
usernames, so the other columns will be blank.)

### Gentle by default

Reading is deliberately gentle — short randomized pauses between API pages. On
`feedback_required` / `please wait a few minutes` / HTTP 429 / challenge, the read
stops immediately (no retry loop).

### DOM fallback (only if the API is blocked)

Expand **DOM fallback** in the panel. Open your Following (or Followers) list in
its modal, then click **Scrape Following** / **Scrape Followers**. It scrolls the
virtualized list and collects usernames as it goes. The API path is preferred — it's
more reliable and provides the numeric `pk`, `full_name`, and `is_private` fields
that scraped lists lack.

## How it works

- Reads `ds_user_id` (your id) and `csrftoken` from cookies; sends
  `x-ig-app-id: 936619743392459` and `x-csrftoken`.
- `GET /api/v1/friendships/{my_id}/following|followers/?count=50&max_id=…`,
  paginating on `next_max_id`.
- Non-mutuals are computed locally as **following − followers** — no write requests
  are ever made.
- A snapshot of the following list is stored locally (`GM_setValue`) after each API
  load; "recently unfollowed" is that snapshot minus the current following list.
- Endpoints/shapes rotate — if a request fails, check them against the live site.

## Editing

It's a single plain-JS file. Edit `instagram-nonmutual-detector.user.js` directly and
bump `@version` in the header. Then either re-save it in the Tampermonkey dashboard,
or **push to `main`** on GitHub — installed users pick up the new version through the
`@updateURL` (Tampermonkey checks periodically, or use *Check for userscript updates*).
