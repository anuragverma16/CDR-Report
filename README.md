# Tata Dialer CDR Report Automation

Upload Tata Dialer CDR exports → map columns → validate → build the agent-wise report → download a formatted Excel workbook and a PNG image → deliver over the official WhatsApp Business Platform, manually or on a schedule.

All numbers come from uploaded CDR files. Nothing is hardcoded, nothing is simulated: if a column is missing it shows **N/A** with a reason, and a WhatsApp send is only shown as successful when Meta's API accepted it.

```
client/   React 19 + Vite + TypeScript + Tailwind v4 dashboard
server/   Node 20+ / Express API, MongoDB (Mongoose), ExcelJS, csv-parse, Playwright, node-cron
```

## Status

| Area | State |
|---|---|
| Upload (.xlsx, .csv), preview, mapping suggestions, validation, normalization, duplicate detection | Done, tested |
| `.xls` (legacy Excel) | Works once SheetJS is installed (see below); otherwise the UI asks to re-save as .xlsx/.csv |
| Agent aggregation, TOTAL row, reconciliation checks, data-quality report | Done, unit + API tested |
| Single and combined reports, cross-file de-duplication, audit trail | Done, tested |
| 4-sheet Excel workbook | Done, tested |
| PNG image (Playwright/Chromium) | Done, tested — needs `npm run install-browser` once on the server |
| Report history, protected downloads, roles | Done, tested |
| WhatsApp Cloud API: templates, media upload, webhook status, destination verification, duplicate-send protection, retries | Implemented and tested against a mock of the Graph API. **Needs your Meta credentials and approved templates before it can send real messages.** |
| Scheduler (persisted in MongoDB, restart-safe, run-once lock, retry worker) | Done, tested |
| Live report from MySQL (`answered_calls` / `missed_calls`): Fetch → report → Send, auto refresh, scheduler uses it when configured | Done, snapshot logic unit tested. Needs the `MYSQL_*` settings. |
| Automatic download of CDRs from Tata Dialer | **Not included.** Without MySQL configured, the scheduler reports on files already uploaded. |
| User management screen | API only (`POST /api/users`, admin). First admin via CLI. |

## Requirements

- Node.js 20 or newer
- MongoDB 6+ (local, Docker, or Atlas)
- Linux/macOS/Windows server that can run headless Chromium (for PNG rendering)

> **Bolt / browser sandboxes:** Bolt's WebContainer cannot run MongoDB or Chromium. Run the server on your machine or a VPS; the client can still be developed anywhere.

## Setup

```bash
# 1. Server
cd server
# edit server/.env: MONGODB_URI, JWT_SECRET, MYSQL_* and NEXSAHAY_* at minimum
npm install
npm run install-browser         # downloads Chromium for PNG rendering
npm run create-admin -- you@company.com "Your Name" 'a-long-password'
npm test                        # calculation tests
npm run dev                     # API on http://localhost:4100

# 2. Client (second terminal)
cd client
npm install
npm run dev                     # http://localhost:5173 (proxies /api to :4100)
```

Production: `cd client && npm run build`, then `cd server && npm start`. The server serves `client/dist` on the same origin, so set `CORS_ORIGIN` to your public URL and `COOKIE_SECURE=true` behind HTTPS.

**Legacy .xls support** (optional): `cd server && npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (SheetJS publishes current versions on its own CDN; the npm-registry `xlsx` package is outdated and has known advisories).

## Using it

1. **Upload CDR** — drop one or more files. The first 20 rows are shown, columns are matched to report fields (agent, status, start time, call ID, number, talk/hold/wrap-up time, disposition). Change any mapping, choose the date format (DMY by default) and duration format, add agent aliases.
2. **Validate** — shows valid / invalid / duplicate-in-file / already-imported counts, the dates found, invalid rows with reasons, and a normalized sample.
3. **Classify** — every distinct call status found is mapped to Answered, Missed or left unmapped; every disposition can be ticked into Interested / Not Interested / Call Back / Answered (Disp). Categories are not mutually exclusive. Suggestions come from the values in the file; you confirm them.
4. **Process** — records are stored with a dedupe key (Call ID when mapped, otherwise agent + start time + number + talk time + status). Save the mapping by name and the next file with the same headers gets it automatically.
5. **Agent Reports** — single file (optionally restricted to the report date) or combined (pick files + date range). A record present in several files is counted once; the Data Quality sheet lists every skipped duplicate and which file it came from.
6. **Report page** — on-screen table, PNG preview, Excel/PNG download, reconciliation, data quality, WhatsApp send.

### Live Report (MySQL)

Set `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` (and the table names if they differ) in `server/.env`, restart the server and open **Live Report**.

1. **Fetch**: pick the date and click *Fetch live report*. Both tables are queried at that moment. Every row from `answered_calls` counts as Answered and every row from `missed_calls` as Missed. Agent, call time, number, talk time and disposition columns are recognized from their names; set `MYSQL_AGENT_COLUMN` / `MYSQL_TIME_COLUMN` if they are not.
2. **Report**: the rows go through the same pipeline as an uploaded file (dedupe, reconciliation, Excel, PNG). Re-fetching the same day replaces that day's earlier snapshot, and if nothing changed the existing report is returned instead of a new one.
3. **Send**: the WhatsApp panel on the same page.

*Auto refresh* re-fetches every 5/15/30 minutes while the page is open. When MySQL is configured, the scheduled run also fetches from MySQL instead of using uploaded files. Use a read-only MySQL user (`GRANT SELECT ON nexsahay_dialer.* ...`).

### Report rules

- Total Calls = unique valid records. Answered/Missed come from your status mapping; statuses you leave unmapped stay in Total but in neither column, and the report flags them.
- Durations are summed in seconds and shown as `HH:MM:SS` (hours can exceed 24). In Excel they are real durations (`[hh]:mm:ss`) so they sum and sort correctly.
- No hold/wrap-up column → `N/A` plus a note. Some files have it and some don't, or some values are blank → value marked `*` (partial) with counts in the note.
- Reconciliation: sum of agents = TOTAL; TOTAL = Answered + Missed + Unmapped; TOTAL = unique records counted per source file; every agent row balances. Reports that fail the first four checks cannot be sent.

## WhatsApp (Meta WhatsApp Business Platform, Cloud API)

What you need from Meta:

1. A Meta Business account, a WhatsApp Business Account and a registered business phone number.
2. A **System User permanent token** with `whatsapp_business_messaging` → `WHATSAPP_ACCESS_TOKEN`; the number's **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. **Two approved templates** (category Utility), both with body variables `{{1}}` date, `{{2}}` total calls, `{{3}}` answered, `{{4}}` missed, `{{5}}` answer rate:
   - one with an **IMAGE** header → `WHATSAPP_TEMPLATE_IMAGE`
   - one with a **DOCUMENT** header → `WHATSAPP_TEMPLATE_DOCUMENT`
4. **Webhook**: callback URL `https://<your-domain>/api/whatsapp/webhook`, verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, subscribe to `messages`. Set `WHATSAPP_APP_SECRET` so signatures are verified.

How sending works:

- Recipients must be **verified** before anything is sent: an admin adds a number, the app shows a code, and the recipient sends `VERIFY 123456` from that number to your business number. The webhook confirms it (this is also their opt-in).
- "Image + Excel" = two template messages. If one part fails, retry sends only that part — the part already accepted is never sent again.
- A new send to the same destination for the same report is blocked while an earlier one succeeded or is awaiting retry; a repeat copy needs explicit confirmation.
- "Accepted by WhatsApp" is Meta's API response. Delivered / read / failed arrive later through the webhook and update Delivery Logs.
- Temporary failures (rate limits, 5xx, Meta codes 131000/131016/130429/133004…) retry automatically every `DELIVERY_RETRY_DELAY_MINUTES` × attempt, up to `DELIVERY_MAX_ATTEMPTS`.
- `WHATSAPP_MESSAGE_MODE=session` sends free-form messages instead of templates; WhatsApp only allows this within 24 hours of the recipient's last message, and the app refuses otherwise.

**Groups.** The Cloud API cannot post into ordinary WhatsApp groups created in the WhatsApp app. Meta's Groups API only works with groups your business creates through the API, needs an Official Business Account, and allows up to 8 participants. The app supports such groups (`WHATSAPP_GROUPS_ENABLED=true`, group verified by looking it up via the API), but the recommended setup is one verified individual recipient per manager. Unofficial WhatsApp Web automation is not used — it risks the number being banned.

## Scheduling

Schedule Settings is stored in MongoDB and loaded into node-cron when the server starts, so it survives restarts and does not depend on a browser tab. Each run:

1. picks processed files that contain calls for the report date (today / previous day / fixed date; optionally limited to selected files),
2. generates the report, Excel and PNG,
3. checks reconciliation,
4. sends to the selected verified destinations,
5. records status, message and report in the schedule and Delivery Logs.

A unique run key (`date + time`) guarantees a slot runs at most once even if several server instances run. "Run saved schedule now" executes immediately with a separate test key.

Run **one** server instance per database for webhook processing; or put a queue in front of the webhook if you scale out.

## Security

- Secrets only in `server/.env` (never sent to the browser; `/api/whatsapp/status` reports only whether they are set).
- Cookie session (httpOnly, SameSite=Lax, `Secure` when `COOKIE_SECURE=true`), origin check on state-changing requests, login rate limit, bcrypt password hashes.
- Roles: **viewer** (view + download), **manager** (upload, process, generate, send, retry), **admin** (schedule, destinations, users, delete files).
- Uploads: extension allow-list, content sniffing (zip/OLE/text), size and file-count limits, random server-side filenames, storage outside the web root, path-traversal-proof file resolution. Downloads only through authenticated routes.
- Webhook: verify-token handshake and HMAC-SHA256 signature check with the app secret.

## API

All routes are under `/api` and require a session except `POST /auth/login` and the webhook.

| Method & path | Role | Purpose |
|---|---|---|
| POST `/auth/login`, POST `/auth/logout`, GET `/auth/me` | — | Session |
| POST `/cdr/upload` (multipart `files`) | manager | Upload, parse, preview, suggest mapping |
| POST `/cdr/preview` | manager | Validate with a mapping/classification (no writes) |
| POST `/cdr/process` | manager | Normalize and store records |
| GET `/cdr/files`, GET `/cdr/files/:id`, DELETE `/cdr/files/:id` | viewer / admin | Files |
| GET `/cdr/mappings` | viewer | Saved column mappings |
| GET `/dashboard/summary`, GET `/dashboard/agents` | viewer | Overview cards |
| POST `/reports/generate`, POST `/reports/generate-combined` | manager | Build report + Excel + PNG |
| GET `/reports`, GET `/reports/:id`, GET `/reports/:id/excel`, GET `/reports/:id/image` | viewer | History & downloads |
| POST `/reports/:id/image/render` | manager | Re-render a failed PNG |
| POST `/reports/:id/send` | manager | WhatsApp send |
| GET `/whatsapp/status`, GET/POST/DELETE `/whatsapp/destinations…` | viewer / admin | Provider status & recipients |
| GET/POST `/whatsapp/webhook` | Meta | Handshake / signed events |
| GET/PUT `/settings/schedule`, POST `/settings/schedule/test` | viewer / admin | Scheduling |
| GET `/delivery-logs`, POST `/delivery-logs/:id/retry` | viewer / manager | Logs & retry |
| GET/POST `/users` | admin | Users |

## Data model (MongoDB)

`User`, `UploadedCDR` (file metadata, headers, mapping, stats), `CdrRecord` (one normalized row + original values), `ColumnMapping` (saved presets), `GeneratedReport` (full report data + file references + delivery status), `ReportSchedule`, `ScheduleRun` (run-once lock), `Destination`, `DeliveryLog` (per-part provider IDs, statuses, history, retries), `AuditLog`.

## Tests

`cd server && npm test` covers duration/time-zone parsing, agent-name normalization, mapping suggestions, duplicate handling within and across files, N/A handling, reconciliation and the Excel layout.

## Deploy: API on Render, website on Vercel

The API (`server/`) runs on Render. The website (`client/`) runs on Vercel. They are on different domains, so the login cookie is cross-site (`SameSite=None; Secure`).

### 1. API on Render
1. Create a MongoDB Atlas cluster. A `127.0.0.1` address does not work on Render.
2. In Render, choose New → Blueprint, select this repository. It reads `render.yaml`.
3. Fill in the variables marked "sync: false":
   - `MONGODB_URI`: the Atlas connection string.
   - `CORS_ORIGIN`: the website's address(es), comma-separated, exact match, no trailing slash, e.g. `https://tata-dialer.vercel.app`. Add each Vercel preview URL you want to use.
   - `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.
   - `NEXSAHAY_API_KEY`, `NEXSAHAY_SESSION_ID`.
   - `ANTHROPIC_API_KEY` (optional).
   - `JWT_SECRET` is generated automatically.
4. Deploy, then open `https://<api>.onrender.com/api/health`. It should show `"ok":true`.
5. In the API's shell, create the first admin: `npm run create-admin`.

The disk in `render.yaml` needs a paid plan. Without it, uploads and generated reports are lost on each restart.

Report images need Chromium. The build runs `npm run install-browser`. If the build cannot install Chromium's system libraries, the image report fails but the Excel report still works.

### 2. Website on Vercel
1. Import this repository in Vercel. Set **Root Directory** to `client`. Vercel reads `client/vercel.json` for the Vite build and the routing for page refreshes.
2. Add the environment variable `VITE_API_URL` = the API address from step 1, e.g. `https://tata-dialer-api.onrender.com` (no trailing slash). Set it for both Production and Preview.
3. Deploy. Then add the Vercel address to `CORS_ORIGIN` on Render and redeploy the API.

### Checklist
- `CORS_ORIGIN` on Render must match the Vercel address exactly.
- `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` (both set in `render.yaml`) must stay as they are for cross-site login.
- After changing `VITE_API_URL`, redeploy the website. The value is built into the site.

Local development is unchanged: leave `VITE_API_URL` empty and run the API and the client as before. Environment settings live in `server/.env` and `client/.env`.
