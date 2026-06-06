# Instagram Non-Mutual Cleanup (Tampermonkey userscript)

Unfollows accounts **you follow that don't follow you back**.
Runs entirely inside your already-logged-in `instagram.com` tab and reuses that
session.

- ✅ Same-origin only — never asks for your username/password, never talks to any
  third-party service.
- ✅ Pick accounts, **Unfollow** with a one-click confirmation.
- ✅ **Export** your following, followers, or non-mutuals to **CSV / JSON / TXT** — built
  in-page and saved straight to your device, nothing uploaded.
- ✅ Gentle throttling with randomized delays, batch pauses, a daily cap, and speed presets.
- ✅ Clean **light / dark** UI (defaults to light); **drag the header** to move the panel
  (position is remembered).
- ✅ Stops immediately on any rate-limit / challenge / `feedback_required` signal.

> Automating Instagram is against IG's Terms of Service. This is for cleaning up
> **your own** account. Keep it gentle; correctness and not getting flagged matter
> more than speed. Use at your own risk.

## Deliverable

A single, self-contained plain-JavaScript userscript:

**`instagram-nonmutual-cleanup.user.js`**

No build step, no dependencies, no `@require`, nothing external — everything
(config, persistence, API client, set math, throttling, shadow-DOM UI, runner, and
DOM fallback) is inlined in that one file.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Add the script, either way:
   - **Drag & drop:** drag `instagram-nonmutual-cleanup.user.js` onto the
     Tampermonkey dashboard, then click **Install**; or
   - **Copy/paste:** open the Tampermonkey dashboard → **+** (Create a new script) →
     replace the template with the full contents of the file → **File ▸ Save**.
   Tampermonkey reads the `// ==UserScript==` header automatically.
3. Open / refresh `https://www.instagram.com/` while logged in. A panel appears in
   the bottom-right corner.

That's it — it's installable as-is.

## Usage

1. Click **Load non-mutuals**. It reads your full following + followers lists via the
   internal web API and logs the counts — verify they roughly match your profile
   header.
2. It computes **non-mutuals = following − followers** and shows them with a
   checkbox each (checked by default). Use **All / None** to bulk-select.
3. Click **Unfollow N** — it unfollows the ticked accounts after one confirmation
   dialog, one at a time with the gentle delays. **Stop** aborts cleanly at any time.
4. Use the 🌙 / ☀ button in the header to switch **light / dark** mode (remembered).

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

### Speed presets & throttling

Open **Advanced settings** for **Speed presets** and individual throttle fields
(persisted with `GM_setValue`):

- **Safe (default):** 40–90 s per unfollow, batches of 7, 4-min rests, cap 80.
- **Medium:** 15–30 s, batches of 10, 2-min rests, cap 120.
- **Fast ⚠:** 7–15 s, batches of 15, 1-min rests, cap 200.

The delays are deliberate: Instagram flags rapid unfollowing with a temporary
**"Action Blocked"**. Faster presets raise that risk — Safe is recommended. On
`feedback_required` / `please wait a few minutes` / HTTP 429 / challenge, the run
stops immediately (no retry loop), and it also bails after 3 errors in a row.

A **Test 1 real unfollow** button (Advanced) performs a single real unfollow and
prints the exact HTTP status + response to the log — handy for diagnosing issues.

### DOM fallback (only if the API is blocked)

Expand **DOM fallback** in the panel. Open your Following (or Followers) list in
its modal, then click **Scrape Following** / **Scrape Followers**. It scrolls the
virtualized list and collects usernames as it goes. With **Use DOM mode** checked,
unfollowing clicks through the row's *Following → Unfollow* confirm dialog (keep the
Following modal open while it runs). The API path is preferred — it's more reliable
and provides the numeric ids needed for the direct unfollow call.

## How it works

- Reads `ds_user_id` (your id) and `csrftoken` from cookies; sends
  `x-ig-app-id: 936619743392459` and `x-csrftoken`.
- `GET /api/v1/friendships/{my_id}/following|followers/?count=50&max_id=…`,
  paginating on `next_max_id`.
- `POST /api/v1/friendships/destroy/{pk}/` to unfollow.
- Endpoints/shapes rotate — if a request fails, check them against the live site.

## Editing

It's a single plain-JS file. Edit `instagram-nonmutual-cleanup.user.js` directly,
bump `@version` in the header if you want Tampermonkey to offer an update, and
re-save in the dashboard.
