# group-expense-tracker-backend

For setup and step-by-step API workflows, see the [Divvy Usage Manual](Divvy_Usage_Manual.md).
For everyday use of the planned mobile app, see the [Divvy App User Guide](Divvy_App_User_Guide.md).

Express API backed by MongoDB/Mongoose. Authentication uses JWTs returned by
`POST /api/auth/login`, sent as `Authorization: Bearer <token>` on protected routes.
Tokens expire after `JWT_EXPIRES_IN` (default: `7d`).

## Logout

Send `POST /api/auth/logout` with the current bearer token and no request body.
Success returns HTTP 200:

```json
{ "success": true, "message": "Logout successful." }
```

The frontend should clear its saved token and user state after success and return
to the login screen. Missing, invalid, expired, or already logged-out tokens return
401; clear local authentication state on 401 as well. A 500 response means server
revocation failed, so the client should allow a retry.

Logout revokes only the submitted token. Other sessions remain valid. MongoDB
stores a SHA-256 hash of the revoked token, with a TTL index that removes the
record after token expiration. All protected routes check this collection.
New login tokens have unique IDs so logins in the same second remain independent.
Existing tokens remain supported; identical tokens issued before this change
are revoked together.

Run `npm test` for authentication tests using mocked database operations.

## Module structure

The backend groups code by feature under `src/modules/`. Each feature owns its
routes, controllers, and models where applicable. Controllers currently contain
validation and business logic.

```text
src/
  app.js                      # Express setup and API route mounting
  config/
    database.js               # Shared database connection
  modules/
    auth/                     # Authentication routes, controller, middleware,
                              # revoked tokens, JWT and token hashing helpers
    users/                    # User model
    groups/               # Group routes, controller, models and access middleware
    expenses/                 # Expense routes, controller and model
    bills/                    # Bill routes, controller and model
    balances/                 # Balance routes and controller
    settlements/              # Settlement routes and controller
    dashboard/                # Dashboard routes and controller
server.js                     # Environment loading and server startup
```

Modules import authentication middleware from `modules/auth` and group
access middleware from `modules/groups`. Cross-feature model imports point
to the owning module. Group API URLs and response fields are documented below.

To add a feature, create its folder under `src/modules/`, place its controller,
routes, and any models there, then mount its router in `src/app.js`.

## Group API and database migration

Divvy supports any people sharing expenses. Group and GroupMember retain their
existing fields and rules; removal sets membership status to INACTIVE (not REMOVED).
The optional descriptive Group type was not added.

All previously group-scoped routes now use `/api/groups`: the root and `/:id`
CRUD routes, `/:id/members`, `/:id/members/:userId`, `/:id/expenses`, `/:id/bills`,
`/:id/balances`, `/:id/settlements`, and `/:id/dashboard`. Existing methods,
`:id` parameter names, authentication and status codes are preserved.
`/api/auth`, `/api/expenses/:expenseId` and `/api/bills/:billId` remain unchanged.
The existing dual router mounts are preserved.

Frontend changes: use `/api/groups` instead of `/api/households`; read `data.group`
and `data.groups` instead of `data.household` and `data.households`; use `groupId`
in membership, expense and bill records. Create/update request bodies retain the
same fields; the scoped URL supplies the relationship ID. Error text now says Group.

Group explicitly uses the existing `households` collection; GroupMember uses
`householdmembers`. There is no collection rename, copy, drop or record deletion.
Expense and Bill still use `expenses` and `bills`. IDs, ownership, timestamps,
membership status and all other fields are retained. The relationship field is
renamed from `householdId` to `groupId` in `householdmembers`, `expenses`, and `bills`.

Deploy with a maintenance window:

1. Back up the MongoDB database and stop all API instances and other writers.
2. Configure `MONGO_URI` in `.env` for the intended existing database.
3. Run `npm run migrate:groups -- --dry-run` (also the default without arguments).
4. Run `npm run migrate:groups -- --apply`.
5. Repeat the dry run; every existing affected collection should report zero.
6. Deploy/start this backend and update frontend clients before resuming traffic.

The script uses raw MongoDB updates to preserve timestamps, detects conflicting
old/new IDs across all affected collections before writing, and refuses to overwrite
conflicts. Resolve any conflict using the backup/source of truth before retrying.
Matching duplicate fields are safely normalized. It is idempotent and can resume
after an interrupted run. Updates are atomic per document, not across collections;
keep writers stopped until the full run succeeds. No migration is run automatically
on server startup. Rolling back the application requires restoring the relationship
field names from the backup during another maintenance window.

The repository URLs in package.json retain the real upstream repository name.
The Word developer guide is a historical source-archive document; the Markdown
guide and this README describe the current code.

## Automatic recurring bills

`server.js` now starts the bill recurrence worker after connecting to MongoDB.
It creates/verifies the unique occurrence index, runs once on startup, then every
60 seconds. Index setup failure stops startup instead of risking duplicates.
No external scheduler, dependency, or new endpoint is needed.

Create a recurring source with the existing `POST /api/groups/:id/bills` endpoint,
using `isRecurring: true` and recurrence `WEEKLY`, `MONTHLY`, or `YEARLY`.
The source is the first actual bill. When its due date arrives, the worker creates
the next bill; each subsequent due date triggers the following occurrence.
After downtime it catches up, including one upcoming occurrence, up to 120 per
source per run; remaining backlog continues on subsequent runs.

Generated bills copy name, amount, category, notes and groupId. They start PENDING
with paidBy null, isRecurring false and recurrence null. They appear in existing
bill lists and dashboard totals and can be paid/edited/deleted through existing
bill endpoints. Generation does not create an Expense or change expense balances.
Generated occurrences cannot be turned into independent recurring sources.

New response/schema fields: recurrenceSourceId links generated bills to their
source, occurrenceNumber identifies their sequence, and generatedThrough tracks
source progress. Existing bills need no field backfill; existing recurring bills
will catch up automatically at first startup, so review their dates before rollout.
The unique source/occurrence index and atomic upserts prevent duplicate generation
across servers and retries. Progress is stored separately so deleting an occurrence
after generation completes does not recreate it.

Date arithmetic uses UTC and the source due date as the anchor. Month/year dates
clamp to the last available day, then return to the original day when possible
(Jan 31 -> Feb 28 -> Mar 31; Feb 29 returns in leap years).

Update the source via `PUT /api/bills/:billId` to change future generated values.
Changing its dueDate or recurrence recalculates future sequence dates from the new
anchor and existing sequence number; already generated bills remain unchanged.
Set source isRecurring false to stop future generation, or delete the source.
Existing generated bills remain as history. Re-enabling resumes the sequence and
catches up. Paying the source does not disable recurrence. In-flight generation
can complete while an edit/deletion is happening; changes apply on the next worker
refresh. Generation requires the backend to be running; startup recovers downtime.

## Receipt upload and scanning

Scanning now uses local Tesseract.js OCR and an English receipt-text parser.
No API key, OpenAI account, or paid OCR service is required. Run `npm install` and
restart the backend. English language data ships as an npm dependency and is loaded
locally; scanning makes no external network calls. Server CPU/memory/hosting costs
still apply. Node.js 22+ is required.

For PDF receipts, install Poppler on the backend host (`brew install poppler` on
macOS or `sudo apt-get install poppler-utils` on Debian/Ubuntu). `pdftoppm` must be
on PATH, or set `PDFTOPPM_PATH` to its absolute executable path. Images do not need
Poppler. PDFs scan at most the first three pages, with bounded raster dimensions.
Missing Poppler returns 503 for PDFs without affecting image scans.

**POST `/api/groups/:id/receipts/scan`**

- Bearer JWT and ACTIVE membership in the Group are required.
- Body: multipart/form-data, exactly one file field named `receipt`.
- Accepts JPEG, PNG, WebP, and PDF, up to 10 MB; MIME and file signatures are checked.
- Postman URL: `{{baseUrl}}/api/groups/{{groupId}}/receipts/scan`.
- Local URL: `http://localhost:5000/api/groups/<groupId>/receipts/scan`.
- In Postman, choose Body -> form-data -> `receipt` -> File. Let Postman generate
  the multipart Content-Type header and boundary.

Uploads are processed locally in an isolated OCR subprocess. Private temporary
files are deleted after completion/failure; no permanent attachment or expense is
created. Scans time out after 60 seconds and disconnecting cancels OCR. English
receipt parsing is heuristic: merchant is a heading candidate, item quantities
are extracted only from explicit quantity/price notation, and unreadable or
ambiguous fields are null. Ambiguous numeric dates and bare dollar symbols are
not assigned a date order or currency. The frontend must always show a review step.

Successful response (unknown/unreadable fields are null):

```json
{
  "success": true,
  "message": "Receipt scanned. Review the extracted values before creating an expense.",
  "data": {
    "groupId": "<groupId>",
    "requiresReview": true,
    "receipt": {
      "isReceipt": true,
      "merchant": "Cafe",
      "date": "2026-10-05",
      "currency": "PHP",
      "subtotal": 200,
      "tax": 24,
      "tip": null,
      "total": 224,
      "items": [{ "description": "Lunch", "quantity": 1, "unitPrice": 200, "total": 200 }],
      "warnings": ["Local OCR uses receipt text patterns. Review every extracted value before saving."]
    }
  }
}
```

The frontend must display an editable review step. Map reviewed merchant to expense
`description`, reviewed total to `amount`, and reviewed date to `date`. Ask the user
for category, payer, participants, and split type, then send the existing
`POST /api/groups/:id/expenses` JSON payload. The scan result is not an expense
payload and does not bypass any expense validation. Expense currency remains the
Group's currency; explicitly resolve a differing receipt currency before saving.
Line items are review data and are not persisted by the existing Expense model.

Errors: 400 missing/invalid multipart input or Group ID; 401 unauthenticated;
403 nonmember; 404 missing Group; 413 over 10 MB; 415 unsupported/mismatched file;
422 non-receipt/unreadable receipt; 429 local throttle; 503 missing PDF renderer; 504 OCR timeout/cancellation.
Internal paths and OCR errors are not returned verbatim.

Per backend process, scanning is limited to five attempts per user per minute and
four concurrent uploads/scans. Invalid upload attempts count toward this limit.
Multiple instances have independent limits. Requests time out after 60 seconds
and a disconnected client cancels its OCR subprocess.

Implementation references: [Tesseract.js](https://github.com/naptha/tesseract.js)
and [local language loading](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).

### Settlement payments

`GET /api/groups/:id/settlements` returns payment suggestions. Record an external
payment with `POST /api/groups/:id/settlements` using `{ "to": "USER_ID", "amount": 300 }`
and optional `paidAt`. The authenticated member is the sender. Both parties must
be active group members. `GET /api/groups/:id/settlements/history?page=1&limit=20`
returns payment history. Recorded payments adjust net balances and dashboard
balances without changing expense totals. See the Usage Manual for limitations.

## Bill reminders and due-date status

`GET /api/groups/:id/dashboard` now includes `data.billReminders`, under the
existing bearer authentication and ACTIVE group membership checks. No new
endpoint, scheduler, migration, or push-notification setup is required.

Bills use **UTC calendar days**, matching the date-only bill contract:
- An unpaid bill before today's UTC midnight is `OVERDUE`.
- An unpaid bill due today or later is `PENDING`, even if a saved legacy status
  says OVERDUE. Today is included until 23:59:59.999 UTC.
- `PAID` always remains paid and is excluded from every reminder group.

Status is derived on reads, without changing stored documents. Bill list,
detail, creation/update responses and dashboard totals use this rule. Bill list
`status=PENDING|OVERDUE|PAID` filters use equivalent database date predicates
before pagination/counting, combined with category/search/recurring filters.
Invalid status values return 400. Existing paid edit/delete locks remain intact.

The additive dashboard field has this shape:

```json
{
  "asOf": "2026-10-16T12:00:00.000Z",
  "timeZone": "UTC",
  "windowDays": 7,
  "overdue": { "count": 0, "amount": 0, "bills": [] },
  "dueToday": { "count": 0, "amount": 0, "bills": [] },
  "dueSoon": { "count": 0, "amount": 0, "bills": [] }
}
```

`dueSoon` covers tomorrow through the seventh day from today, inclusive (today
is its own group). Counts and amounts include all matching group bills; amounts
use the group's currency and cents rounding. Each `bills` preview contains at
most five populated bill records, ordered by dueDate ascending then ID, with
effective status. Use the existing paginated bill list to see additional bills.
The existing `upcomingBills` preview now includes bills due today. Paid bills
leave reminders on the next fetch. Responses refresh when fetched; no background
notifications or mobile reminder UI are added by this backend change.


## Bill payment timestamp

Bills now expose nullable `paidAt` (ISO timestamp). When an unpaid bill is marked
PAID through `PUT /api/bills/:billId`, the server records its current time in the
same conditional database update as status/paidBy. The existing paid-bill lock
prevents later edits, reopening, or duplicate requests from changing this date.
Creation directly with `status: "PAID"` also records the server time; ordinary
unpaid creation/updates keep `paidAt: null`. Client-supplied `paidAt` is ignored.
This timestamp means **when payment was recorded**, not a user-entered historical
payment date.

Bill list/detail/create/update responses and dashboard bill records include this
field. Existing paid bills without a timestamp return `paidAt: null`; no guessed
backfill from updatedAt or dueDate is performed, and no migration is required.
