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

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Docker image, single-host Compose setup,
production environment template, staging checks and remaining hosting decisions.

## Startup and deployment readiness

Set `MONGO_URI` to a MongoDB URI and `JWT_SECRET` to a securely generated secret
containing at least 32 UTF-8 bytes. Startup rejects missing or invalid settings.
`PORT` defaults to 5000; `JWT_EXPIRES_IN` defaults to `7d` and must be a positive
duration. Set `NODE_ENV=production` on the host. Never commit environment secrets.

Use `/api/health` for process liveness and `/api/ready` for database readiness.
Readiness returns 503 when MongoDB is disconnected, its bounded ping fails, or
shutdown has begun. SIGTERM/SIGINT stops new connections and the recurring bill
timer, drains HTTP requests, and disconnects MongoDB, with a 10-second deadline.

Registration requires nonblank names (maximum 100 characters each), a valid email
(maximum 254 characters), and a password of at least 8 characters and at most 72
UTF-8 bytes. Login continues to accept existing shorter passwords.
Authentication limits are per IP per process over 15 minutes: 20 unsuccessful
login attempts or 5 registration requests. Excess requests return JSON 429 with
Retry-After. Proxy trust is disabled by default; configure only the actual trusted
proxy topology before deploying behind a reverse proxy, otherwise users may share
the proxy's quota. Use a shared rate-limit store or gateway limits before scaling
to multiple instances; memory counters reset on restart.

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


## Dashboard spending periods

`GET /api/groups/:id/dashboard?period=this_month` accepts exactly `all_time`,
`this_month`, or `last_month`. Omission defaults to `all_time`, preserving the
existing totals. Invalid/blank/structured/repeated period values return 400.
Authentication and ACTIVE group membership requirements are unchanged.

Only `data.summary` (`totalExpenses`, `totalPaid`, `totalOwed`) and
`data.recentExpenses` are selected by the expense's `date`, not createdAt or bill
payment dates. Recent expenses remain the newest five by date/createdAt.
UTC calendar months include their full last day, with an inclusive month start
and exclusive next-month start. This month includes the entire current calendar
month, including any future-dated expenses recorded within it.

The additive `data.period` describes the selection:

```json
{
  "value": "this_month",
  "timeZone": "UTC",
  "startDate": "2026-10-01",
  "endDate": "2026-10-31"
}
```

startDate/endDate are inclusive YYYY-MM-DD labels suitable for the Expenses
endpoint. For all_time both are null. Member balances and recorded settlements
always use all history. Bill totals, payment history, upcoming bills and reminder
groups remain current and independent of the spending period, so selecting an
older month does not hide unpaid debt or overdue bills. No schema change or data
migration is required.


## Dashboard category breakdown

`GET /api/groups/:id/dashboard` now adds `data.spendingByCategory`, using the
same group and selected UTC spending period as `data.summary`. Each entry is:

```json
{ "category": "GROCERIES", "amount": 1500, "count": 3, "percentage": 60 }
```

Amounts use the group's currency. Each expense contributes its full amount once,
regardless of split type/number of participants. Amounts accumulate in integer
cents; their sum agrees with summary.totalExpenses and summary.totalPaid. Count
is the number of expenses, and percentage is its share of total period spending,
rounded independently to two decimals (percentages may sum to 99.99 or 100.01).
Entries sort by amount descending, then category alphabetically for ties. Only
categories with recorded expenses appear; an empty period returns `[]`.
Missing/unrecognized legacy categories are grouped under OTHERS; known legacy
category casing/whitespace is normalized for the response without editing data.
Bills and settlements never contribute to this breakdown. Current balances,
bill summaries and reminders retain their existing behavior. No migration,
new endpoint, or dependency is required.


## Month-over-month spending comparison

The dashboard adds nullable `data.spendingComparison`. For `this_month`, it
compares the current UTC calendar month with last month. For `last_month`, it
compares last month with the preceding month. For `all_time` (including the default
request), it is null. It uses group expenses' dates and full amounts, excludes
bills/settlements, and does not change live balances or reminder data.

```json
{
  "timeZone": "UTC",
  "basis": "calendar_month",
  "current": { "startDate": "2026-10-01", "endDate": "2026-10-31", "amount": 2000, "isInProgress": true },
  "previous": { "startDate": "2026-09-01", "endDate": "2026-09-30", "amount": 2500 },
  "difference": -500,
  "percentageChange": -20,
  "direction": "decrease"
}
```

Date labels are inclusive. Calculations use inclusive month start/exclusive next
month start and integer cents, matching summary.totalExpenses and category totals.
Difference is selected minus previous; direction is increase/decrease/unchanged.
Percentage change is signed, rounded to two decimals, and null whenever previous
spending is zero (including both months empty). A decrease to zero from a nonzero
previous month is -100 percent. Missing prior-month entries mean zero recorded
spending, not an estimate of spending outside the app.

These are full calendar-month windows, not matched month-to-date windows. The
current month may still be in progress and includes future-dated recorded expenses
within that month, consistent with existing period totals. `current.isInProgress`
is true for this_month so the UI can communicate that distinction. All-time has
no meaningful prior calendar month. No new endpoint, migration or dependency is
needed; existing query validation and group authorization still apply.

### Expense and bill list sorting

Both group list endpoints accept a single `sort` query parameter, applied before
pagination and combined with existing search/filters. Sort does not change counts.

- `GET /api/groups/:id/expenses`: `newest` (default), `oldest`,
  `amount_high`, `amount_low`. Newest/oldest use expense date, then creation
  time and ID in the same direction. Amount ties use newest expense first.
- `GET /api/groups/:id/bills`: `due_soonest` (default), `due_latest`,
  `amount_high`, `amount_low`. Due-date ties use creation time and ID descending.
  Amount ties use nearest due date, then creation time and ID descending.

Values are exact, case-sensitive strings. Blank, unknown, repeated or structured
values return HTTP 400. Omission preserves the existing primary/default order.
Unique ID tie-breakers keep records with equal dates/amounts consistently ordered.
Authentication and active membership requirements are unchanged.


### Group creation currency

`POST /api/groups` accepts `{ "name": "Trip", "currency": "USD" }` with bearer authentication.
Currency is optional (defaults to PHP), trimmed and uppercased. Supported values are the 155 current ISO 4217 currencies in
`src/modules/groups/group.currencies.json`, sourced from SIX List One published
2026-09-17. Funds, precious metals, testing and no-currency codes are excluded.
Invalid or unsupported values return 400 before creating records. Success returns
201 with the saved currency in `data.group.currency`. Amounts and splits use the currency’s ISO minor unit precision: whole units for
JPY, two decimals for PHP/USD, and three for KWD/BHD. Percentages allow two decimals.
Excess amount precision is rejected with 400 rather than rounded. Equal splits
assign the remainder to the first participant; percentage splits reconcile to
the exact total, redistributing excess rounding to avoid negative shares. No exchange conversion is performed.
Existing groups are unchanged.


### Native currency precision (2026-10-22)

The currency precision catalog lives in `src/utils/currency-precision.json`.
Existing amount fields remain numbers in major units; this change performs no
conversion, backfill, or database writes. Expenses, exact splits, bills and
repayments validate native precision on creation/update. Minimum supported
amount is 1 native minor unit (e.g. JPY 1, PHP 0.01, KWD 0.001).
Dashboard totals, category breakdowns, comparisons, reminders, balances and
settlement suggestions sum integer minor units. Recurring bills preserve the
source amount and check its currency precision before generating occurrences.

Legacy records that violate native precision (e.g. fractional JPY from an older
client) must be reviewed against original records. Calculations return HTTP 409
with an explanation rather than silently rounding those amounts; recurring
sources with that conflict are skipped and logged. No automatic correction is
performed. Historical fractional values remain visible in the mobile detail
screens for review. Currency changes on groups with expenses, bills or
settlements return 409 to prevent reinterpreting recorded amounts. Mobile
settings continue to show currency read-only. Deploy backend and mobile changes
together; older clients restrict entry/display to two decimals.


### Itemized expenses

Standard EQUAL/EXACT/PERCENTAGE expenses remain the default. Create an itemized
expense using the existing authenticated group expense endpoint:

```json
{
  "description": "Dinner",
  "amount": 15,
  "paidBy": "ACTIVE_USER_ID",
  "splitType": "ITEMIZED",
  "items": [
    { "description": "Pizza", "quantity": 2, "amount": 10, "memberIds": ["USER_A", "USER_B"] },
    { "description": "Drink", "quantity": 1, "amount": 5, "memberIds": ["USER_A"] }
  ]
}
```

Use actual active member ObjectIds. Omit `participants`; the server derives them
from item assignments (USER_A owes 10 and USER_B owes 5 in this example).
`amount` on an item is the full line total for all quantity. Quantity is metadata,
not a multiplier. Quantity defaults to 1, must be positive, <=1,000,000 and have
up to 3 decimals. Require 1–100 items, trimmed descriptions of 1–200 characters,
nonnegative safe amounts matching the currency precision, and at least one
unique active member per line. Line totals must equal the positive expense total.
Each line splits equally, with its rounding remainder assigned to its first
member, then aggregates into the stored participant shares. Invalid itemization
returns 400 before writes; client-supplied participants are rejected.

GET/create/update expense responses preserve `items`. Partial updates retain
itemized mode/items and recalculate shares. Explicitly selecting a standard split
and sending its participants clears the old items. Existing standard requests
need no changes. No migration is required. Existing dashboards, balances and
settlement suggestions use the derived shares without counting items again.
Receipt scanning still only extracts data for review; the mobile editor can
prefill descriptions, quantities and line totals, leaving missing fields and
member assignments for the user. Tax/tip may be separate assigned lines. Negative
discounts and automatic proportional tax/tip allocation are not implemented.
Deploy backend support before clients that submit ITEMIZED expenses.


## Itemized tax and tip allocation (verified 2026-10-22)

- ITEMIZED create/update requests accept optional `adjustments: { tax?: { amount, allocation }, tip?: { amount, allocation } }`. Each amount is a nonnegative number with native currency precision; allocation is `EQUAL` or `PROPORTIONAL`. Missing adjustments preserve legacy behavior. The expense total must equal line totals plus tax plus tip. Standard requests reject adjustments; converting to Standard clears stored adjustments.
- Tax and tip independently allocate among the unique members assigned to items, in first-appearance order. EQUAL includes members assigned only zero-cost items. PROPORTIONAL uses each member’s allocated item subtotal before either adjustment (including existing per-line rounding), so tip never includes tax. A positive proportional charge with zero item subtotal is rejected; choose EQUAL instead. Zero charges are allowed in either mode.
- All calculations use exact integer native minor units. Each adjustment uses largest-remainder allocation, with ties resolved by member first-appearance order. Server-derived participants include items and both charges, so balances and settlement suggestions include extras once. Submitted participant totals remain forbidden for ITEMIZED.
- Responses persist adjustment amounts and methods. Partial updates retain omitted adjustments and revalidate/recalculate; supplying `adjustments` replaces the entire adjustment object, so `{}` clears both. Omit a tax/tip key to remove it when replacing the object. No data migration is required.
- Mobile provides tax/tip amount fields and independent Equally / By item amounts controls, defaulting to proportional. Blank means zero. Receipt tax and tip prefill for review; remove duplicate tax/tip item lines before using dedicated extras. Existing receipt review and total checks remain. Draft changes participate in unsaved-change protection. Preview shows each member’s item subtotal, tax, tip and final total; details show saved charges and methods, and editing restores them.
- Deploy the backend before the updated itemized mobile flow. Older clients do not understand saved adjustments and should be updated before editing these expenses.


## Split by shares (verified 2026-10-22)

- Standard expenses additionally support `splitType: "SHARES"` with `participants: [{ userId, shares }]`. Shares must be numeric positive whole numbers from 1 to 1,000,000. A 2:1 weight divides the total in that ratio. Existing authentication, unique participant, ACTIVE membership and payer checks apply.
- The server calculates participant amounts from weights, ignoring any submitted participant amounts. Calculations use integer native currency minor units and exact integer arithmetic. Fractional allocations are floored, then remaining units go to the largest fractional remainders, with participant order breaking ties. Amounts always reconcile to the expense total, including JPY and KWD.
- Responses persist `participants[].shares` alongside calculated amounts. Updates retain omitted weights and recalculate when the total changes. Mobile loads weights when editing and displays them in expense details. Switching split modes replaces the corresponding participant metadata. No migration is required; existing splits retain their behavior.
- Mobile keeps Standard and Equal as the defaults. By shares includes an icon, defaults each selected member to 1, supports number entry and plus/minus controls, and previews each amount and total shares before saving. Invalid weights block saving.
- Deploy the backend before using SHARES on mobile. Older backend versions do not support this split type.


## Expanded expense and bill categories (verified 2026-10-22)

- Expense categories additionally accept COFFEE, TRAVEL, ACCOMMODATION, FUEL, PARKING, EDUCATION, PETS, GIFTS, HOME_MAINTENANCE, PERSONAL_CARE, FITNESS and SUBSCRIPTIONS.
- Bill categories additionally accept GAS, ASSOCIATION_DUES, EDUCATION, CHILDCARE, LOAN, CREDIT_CARD, PROPERTY_TAX and MAINTENANCE.
- Existing category identifiers and Other defaults are preserved. New values use the same create/update/list category contract. Dashboard expense breakdowns recognize the expanded schema enum, and mobile dashboard shortcuts accept them as filters. Forms, filters, list/detail labels and icons include the new values; multiword identifiers display with spaces. No migration is needed. Deploy the backend category enums before using the updated mobile selectors.


## Recurring expenses (verified 2026-10-22)

- `POST /api/groups/:id/expenses` accepts optional `recurring: { frequency: "WEEKLY" | "MONTHLY" | "YEARLY", endDate?: "YYYY-MM-DD" | null }`. The first expense is recorded normally and owns the schedule. Omission preserves one-off behavior. The backend validates the schedule before writing. Dates use UTC; end dates include the entire final UTC day and cannot precede the first expense date. Monthly/yearly dates derive from the original anchor, preserving month-end/leap-year behavior without drift.
- Expense responses optionally include `recurring: { frequency, anchor, endDate, paused, nextNumber, nextDate, lastError }`. Generated occurrences instead include `recurrenceSourceId` and `occurrenceNumber` and have no schedule. They reuse the source's description, amount, category, notes, payer and full participant split, including SHARES weights, ITEMIZED lines/assignments, tax and tip. Each recorded entry contributes to balances and spending once.
- `PATCH /api/expenses/:expenseId/recurrence` accepts `paused?: boolean` and/or `endDate?: "YYYY-MM-DD" | null`. Existing bearer/ACTIVE membership checks apply. Only originals with a schedule accept management; invalid input returns 400, nonmembers 403, and concurrent processing/progress changes 409 with retry guidance. A successful response contains the updated populated `data.expense`.
- Pause prevents future generation. Resume skips missed paused dates and continues at the next future anchored occurrence. Extending a completed schedule also restarts from the next future date. Clearing the end date removes the limit. Next date null means no remaining occurrences within the limit; pause is independent. Future source edits reuse the new amount/payer/split; existing generated records are not rewritten. Original expense dates/frequency remain fixed to preserve the anchor; manage pause/end dates in details. Generated occurrences edit independently. Deleting the original stops the schedule and preserves existing occurrences.
- The backend starts a recurring-expense worker after connecting, installs the unique partial `(recurrenceSourceId, occurrenceNumber)` index before starting, and runs every 60 seconds with a local overlap guard. Each due occurrence uses a source lease plus an atomic upsert with a permanent unique occurrence key. Progress advances only after persistence. Retries and overlapping servers cannot insert duplicate occurrence keys; duplicate-key errors are accepted only after verifying the exact occurrence exists. Expired leases recover after 60 seconds. Source edits, deletes and schedule controls reject active leases. Deletion of a generated entry still awaiting its source checkpoint returns 409, preventing recreation after an interrupted write/checkpoint. The worker catches up after downtime in bounded batches of 120 per source; paused periods are skipped on explicit resume.
- The worker rechecks the group and ACTIVE membership of payer and all participants before generating. Unavailable members/groups automatically pause the schedule with a review message; no invalid expense is written. Native currency precision and participant totals are validated. Worker failures retain progress for retry and are logged. An already processing occurrence may finish before a pause request can succeed.
- Mobile provides an optional Repeat this expense control on creation, weekly/monthly/yearly choices, inclusive optional end date, list schedule badges, and details controls for pause/resume/end-date changes. Source editing explains the future-entry scope and fixes the anchor date. Generated details link to the original schedule. Create drafts include schedule fields in unsaved-change protection. Successful schedule mutations invalidate expense list/detail and dashboard caches.
- Deploy the backend before this mobile flow. No data migration is required for existing one-off expenses; the new indexes are installed on startup. Run the backend continuously for scheduled generation; stopped servers catch up when restarted. This records expenses automatically and does not initiate payment transfers.
