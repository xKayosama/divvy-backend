# Divvy Usage Manual

For instructions written for app users, see the [Divvy App User Guide](Divvy_App_User_Guide.md).

Use Divvy to organize shared expenses, track bills, and calculate who owes whom. This manual covers running the backend and using its API through Postman. The mobile HTML file in this repository is a design mockup; the running backend is accessed through API requests.

## 1. Understand the workflow

1. Start the backend and confirm it is reachable.
2. Register accounts and log in.
3. Create a group and add registered members.
4. Record expenses with the correct payer and participants.
5. Track upcoming bills and review scanned receipts.
6. Check balances and suggested settlements.
7. Log out when finished.

An **expense** records money paid and how the cost is shared. A **bill** tracks an obligation and its status. Expenses and recorded settlement payments affect balances. A **settlement suggestion** describes a payment between members; it does not send money. Record completed payments separately through the settlement API.

## 2. Install and start the backend

You need Node.js 22 or newer, npm, a reachable MongoDB database, and an API client such as Postman.

In a terminal, open the project and install its locked dependencies:

```sh
cd /Users/m2/household-expense-tracker-backend
npm ci
```

Create or edit `.env` in the project root. Preserve your existing working values if it is already configured. These are example values, not credentials for a deployed service:

```dotenv
MONGO_URI=mongodb://127.0.0.1:27017/divvy
JWT_SECRET=replace-with-a-long-random-secret
JWT_EXPIRES_IN=7d
PORT=5000
```

Start MongoDB separately if you use a local database, then run:

```sh
npm run dev
```

Keep this terminal running. For a start without automatic development restarts, use `npm start`. Stop the server with Control+C.

Send `GET http://localhost:5000/api/health`. A working API returns HTTP 200:

```json
{"success":true,"message":"Divvy API is running"}
```

The health endpoint confirms the API responds; it is not a full database diagnostic. Startup also prepares recurring bill generation, so database/index setup failures can prevent the server from starting.

For an existing database with legacy `householdId` fields, follow the backup, maintenance window, and migration procedure in [README.md](README.md#group-api-and-database-migration) before using this version. A fresh database does not need that relationship-field migration.

### Enable PDF receipt scanning

Image scanning works with the installed npm dependencies. PDF scanning additionally needs Poppler on the backend host:

```sh
# macOS
brew install poppler

# Debian or Ubuntu
sudo apt-get install poppler-utils
```

Use the command for your operating system. `pdftoppm` must be on PATH; alternatively set `PDFTOPPM_PATH` in `.env` to its absolute executable path and restart the backend.

## 3. Prepare Postman

Create a Postman environment with these variables:

| Variable | Value or source |
| --- | --- |
| `baseUrl` | `http://localhost:5000` without a trailing slash |
| `token` | `data.token` from login |
| `groupId` | `data.group._id` from group creation |
| `userIdA` | First user's `data.user.id` from registration or login |
| `userIdB` | Second user's `data.user.id` from registration or login |
| `expenseId` | `data.expense._id` from expense creation |
| `billId` | `data.bill._id` from bill creation |

For protected requests, select **Authorization → Bearer Token** and enter `{{token}}`. For JSON requests, select **Body → raw → JSON**, which sets `Content-Type: application/json`. GET requests and the DELETE requests below need no body.

Replace placeholders through environment variables. IDs are database IDs, not names or email addresses. Some responses use `id`, while raw database records use `_id`; copy the field specified above. Group details expose user IDs at `data.members[].id`; the separate member-list endpoint uses populated `data.members[].userId._id`.

## 4. Register and log in

### Register an account

Send `POST {{baseUrl}}/api/auth/register` without bearer authentication:

```json
{
  "firstName": "Ana",
  "lastName": "Reyes",
  "email": "ana@example.com",
  "password": "example-only-change-this-password"
}
```

All four fields are required. Use your own password. Expect HTTP 201 and save `data.user.id` as `userIdA`. Registration does not return a login token.

For the two-person examples, register a second account with a different email, such as `ben@example.com`, and save its ID as `userIdB`.

### Log in

Send `POST {{baseUrl}}/api/auth/login` without bearer authentication:

```json
{
  "email": "ana@example.com",
  "password": "example-only-change-this-password"
}
```

Expect HTTP 200. Copy `data.token` into `token`. Check the session with `GET {{baseUrl}}/api/auth/me` using bearer authentication.

The default token lifetime is seven days, configurable with `JWT_EXPIRES_IN`. A 401 response means you need to clear the invalid token and log in again. When testing multiple accounts, keep their tokens separate so you know whose permissions each request uses.

## 5. Create and manage a group

### Create a group

While logged in as Ana, send `POST {{baseUrl}}/api/groups`:

```json
{"name":"Apartment Expenses"}
```

Expect HTTP 201. Save `data.group._id` as `groupId`. Ana becomes the group owner and an active member. The default currency is PHP. Group creation currently reads the name only; change currency through the update endpoint.

Send `GET {{baseUrl}}/api/groups` to list your active groups, or `GET {{baseUrl}}/api/groups/{{groupId}}` to see a group's details and active members.

### Add a member

As the owner, send `POST {{baseUrl}}/api/groups/{{groupId}}/members`:

```json
{"email":"ben@example.com"}
```

The person must already have an account. This adds them immediately; it does not send an invitation email. Expect HTTP 201. An inactive former member can be added again by email.

### Change group details

As the owner, send `PUT {{baseUrl}}/api/groups/{{groupId}}`:

```json
{"name":"Apartment Expenses","currency":"PHP"}
```

Choose the currency before recording expenses. Changing the currency label does not convert existing amounts. Divvy has no exchange-rate conversion workflow.

### Permissions and removal

| Action | Who can do it |
| --- | --- |
| Create a group and list own groups | Logged-in user |
| View group data, scan receipts, and manage group expenses and bills | Active member |
| Rename a group, change currency, add or remove members, delete a group | Group owner |

Active members can edit or delete other members' expenses and bills in the group. These actions are not limited to the original creator.

To remove a member, the owner sends `DELETE {{baseUrl}}/api/groups/{{groupId}}/members/{{userIdB}}`. The owner cannot remove themselves. Removal makes membership inactive and removes access; historical expenses remain. Balance calculations include only active members, so review outstanding amounts before removing someone.

## 6. Record an expense

Send `POST {{baseUrl}}/api/groups/{{groupId}}/expenses`:

```json
{
  "description": "Weekly groceries",
  "amount": 1500,
  "category": "GROCERIES",
  "paidBy": "{{userIdA}}",
  "splitType": "EQUAL",
  "participants": [
    {"userId":"{{userIdA}}"},
    {"userId":"{{userIdB}}"}
  ],
  "date": "2026-10-15",
  "notes": "Shared household groceries"
}
```

Expect HTTP 201. Save `data.expense._id` as `expenseId`. Ana paid PHP 1,500, and each person owes a PHP 750 share.

Use a positive amount with at most two decimal places. The payer and all participants must be active members. Include each participant once. Include the payer in participants only if they should bear a share of the cost; paying does not automatically make someone a participant. Use the actual transaction date in `YYYY-MM-DD` format; if omitted, the date defaults to now.

Valid expense categories are `FOOD`, `RENT`, `UTILITIES`, `INTERNET`, `TRANSPORTATION`, `GROCERIES`, `HEALTHCARE`, `ENTERTAINMENT`, `SHOPPING`, and `OTHERS`.

### Choose a split

| Type | Participant fields | Rule |
| --- | --- | --- |
| `EQUAL` | `userId` | Divides equally; leftover cents go to the first participant |
| `EXACT` | `userId`, `amount` | Participant amounts must total the expense amount |
| `PERCENTAGE` | `userId`, `percentage` | Percentages must total 100; rounding adjustment goes to the last participant |

For an exact split of PHP 1,500, replace the split fields in the create payload with:

```json
{
  "splitType": "EXACT",
  "participants": [
    {"userId":"{{userIdA}}","amount":900},
    {"userId":"{{userIdB}}","amount":600}
  ]
}
```

For a 60/40 split, use:

```json
{
  "splitType": "PERCENTAGE",
  "participants": [
    {"userId":"{{userIdA}}","percentage":60},
    {"userId":"{{userIdB}}","percentage":40}
  ]
}
```

These snippets replace fields within the full expense payload; they are not standalone create requests.

### Find, correct, or delete expenses

| Task | Request |
| --- | --- |
| List expenses | `GET /api/groups/{{groupId}}/expenses` |
| Filter expenses | `GET /api/groups/{{groupId}}/expenses?category=GROCERIES&startDate=2026-10-01&endDate=2026-10-31&page=1&limit=20` |
| View one | `GET /api/expenses/{{expenseId}}` |
| Correct one | `PUT /api/expenses/{{expenseId}}` with changed JSON fields |
| Delete one | `DELETE /api/expenses/{{expenseId}}` |

Prefix these paths with `{{baseUrl}}`. Lists return `data.expenses` and a separate `pagination` object; the maximum page size is 100. Date filters include both endpoints of the range using UTC calendar days.

For example, an update body can be `{"notes":"Receipt verified"}`. When changing the amount or split, send the intended participants and amounts or percentages together so the split stays valid. Editing and deleting expenses immediately changes calculated balances. Check the ID before deleting; the API has no undo endpoint.

## 7. Scan and review a receipt

1. Send `POST {{baseUrl}}/api/groups/{{groupId}}/receipts/scan` with bearer authentication.
2. Select **Body → form-data**.
3. Add exactly one key named `receipt`, change its type to **File**, and select the receipt.
4. Let Postman generate the multipart header and boundary; remove a manually set JSON Content-Type for this request.
5. Send the request and review `data.receipt`.

Accepted files are JPEG, PNG, WebP, and PDF, up to 10 MB. PDFs scan at most the first three pages. Local English OCR can take up to 60 seconds. Each backend process allows five attempts per user per minute and four simultaneous uploads/scans.

Check merchant, date, currency, total, and warnings against the original. Unknown or ambiguous values can be `null`; correct them before saving. In particular, a bare dollar symbol does not reliably identify a currency.

Scanning creates no expense and stores no permanent receipt attachment. After review, create an expense through the normal expense endpoint: use the reviewed merchant as `description`, total as `amount`, and date as `date`; choose category, payer, participants, and split yourself. Resolve a receipt currency that differs from the group currency before submitting. Extracted line items are review information and are not saved in the current expense model.

## 8. Track bills and recurring obligations

Send `POST {{baseUrl}}/api/groups/{{groupId}}/bills`:

```json
{
  "name": "Monthly internet",
  "amount": 1800,
  "category": "INTERNET",
  "dueDate": "2026-11-01",
  "isRecurring": true,
  "recurrence": "MONTHLY",
  "status": "PENDING",
  "notes": "Shared internet subscription"
}
```

Expect HTTP 201. Save `data.bill._id` as `billId`. For a one-time bill, use `"isRecurring":false` and omit `recurrence`. Use actual JSON booleans rather than quoted strings.

Bill categories are `RENT`, `ELECTRICITY`, `WATER`, `INTERNET`, `PHONE`, `SUBSCRIPTION`, `INSURANCE`, and `OTHER`. Bill statuses are `PENDING`, `PAID`, and `OVERDUE`. Recurrence supports `WEEKLY`, `MONTHLY`, and `YEARLY`.

### Mark a bill paid

Send `PUT {{baseUrl}}/api/bills/{{billId}}`:

```json
{"status":"PAID","paidBy":"{{userIdA}}"}
```

This records bill status and payer only. If the payment should be shared in balances, also create one expense for the payment using the appropriate expense category and participants. Avoid creating a duplicate expense if it was already recorded. Supplying `paidBy` alone does not automatically set the status to PAID.

A past due date does not automatically change a PENDING bill to OVERDUE. Update its status explicitly when needed.

### Manage recurrence

The original recurring bill is the first actual bill. When it becomes due, the running backend generates the next occurrence. The worker runs at startup and about every minute, catches up after downtime, and may need several runs for a large backlog.

Generated bills start PENDING with no payer and link to their source through `recurrenceSourceId`. Their own `isRecurring` is false; filtering for `isRecurring=true` shows sources rather than the entire generated series. Paying the source does not stop the series.

To stop future generation, update the source bill with `{"isRecurring":false}`. To resume, update the source with `{"isRecurring":true,"recurrence":"MONTHLY"}` or another supported frequency. Resuming catches up missed occurrences. Changing source values affects future generation; existing occurrences retain their values. Changes to dates or frequency use the existing sequence position and can shift future dates. An occurrence already being generated may finish during a change.

Monthly and yearly scheduling uses UTC and clamps dates to the last valid day when necessary, while retaining the original day as its anchor. For example, a January 31 monthly source generates February 28 and then March 31 in a non-leap year.

### Find or delete bills

| Task | Request |
| --- | --- |
| List bills | `GET /api/groups/{{groupId}}/bills` |
| Search bill names and notes | `GET /api/groups/{{groupId}}/bills?search=rent` |
| Filter pending bills | `GET /api/groups/{{groupId}}/bills?status=PENDING&page=1&limit=20` |
| Filter recurring sources | `GET /api/groups/{{groupId}}/bills?isRecurring=true` |
| View one | `GET /api/bills/{{billId}}` |
| Edit one | `PUT /api/bills/{{billId}}` |
| Delete one | `DELETE /api/bills/{{billId}}` |

Prefix these paths with `{{baseUrl}}`. Lists return `data.bills` and `pagination`; category filtering is also supported. Use `search` for case-insensitive literal matching in bill names or notes; combine it with any existing filter. Search text is trimmed and limited to 200 characters; blank search returns the unfiltered list. Deleting a source stops future generation but retains existing generated bills. Deleting a completed generated occurrence does not normally recreate it. A generated occurrence cannot become a recurring source; create a new recurring bill if needed.

## 9. Read balances and settlements

Send `GET {{baseUrl}}/api/groups/{{groupId}}/balances`.

| Field | Meaning |
| --- | --- |
| `paid` | Total the member paid for recorded expenses |
| `owed` | Total of the member's assigned expense shares |
| `net` | `paid - owed + settlementPaid - settlementReceived`; positive means receive money, negative means owe money |

If the PHP 1,500 equal-split grocery expense is the only expense:

| Member | Paid | Owed | Net |
| --- | --- | --- | --- |
| Ana | 1500 | 750 | +750 |
| Ben | 0 | 750 | -750 |

Send `GET {{baseUrl}}/api/groups/{{groupId}}/settlements`. The suggested payment is Ben → Ana for PHP 750, returned under `data.settlements` with `from`, `to`, and `amount`.

Arrange the actual transfer outside Divvy, then record it as the logged-in sender:

```http
POST {{baseUrl}}/api/groups/{{groupId}}/settlements
Content-Type: application/json

{
  "to": "RECIPIENT_USER_ID",
  "amount": 300,
  "paidAt": "2026-01-01T10:00:00.000Z"
}
```

`paidAt` is optional and defaults to now; future dates are rejected. The recipient must be another active group member. Amounts must be positive numbers with at most two decimal places. `from` and `recordedBy` are set to the authenticated sender; you cannot record someone else's payment.

After Ben records PHP 300 paid to Ana, the remaining suggestion is PHP 450. Recording the remaining PHP 450 clears their balances. Expense totals stay unchanged; member responses include `settlementPaid` and `settlementReceived`, and dashboard net balances also include these payments.

Retrieve recorded payments using `GET {{baseUrl}}/api/groups/{{groupId}}/settlements/history?page=1&limit=20`. History returns `data.settlements` and `pagination`, sorted by payment date, newest first. The maximum limit is 100. All settlement routes require authentication and active group membership.

These are self-reported payments, without recipient confirmation or payment-provider verification. Record each transfer once: duplicate submissions create separate records. Payments are not capped to the current suggestion; overpayments reverse the remaining balance. Editing or deleting payment records is not available in this version. Do not enter reimbursements as shared purchases.

## 10. Review the dashboard

Send `GET {{baseUrl}}/api/groups/{{groupId}}/dashboard` for a summary of expenses, member balances, and bill statuses, plus the latest five expenses and up to five future PENDING bills.

Review full expense and bill lists for complete history. Dashboard upcoming bills exclude past-due PENDING bills, so also inspect bill lists when checking missed obligations.

## 11. Log out and delete data deliberately

Send `POST {{baseUrl}}/api/auth/logout` with the current bearer token and no body. After HTTP 200, clear the saved token. Logout revokes that token; other sessions remain active. On 401, clear the invalid local token as well. On 500, retry logout because server revocation failed.

To permanently delete a group, its owner sends `DELETE {{baseUrl}}/api/groups/{{groupId}}`. This deletes the group, memberships, expenses, and bills. There is no API undo; preserve any records you need beforehand.

## 12. Troubleshoot common problems

| Problem | What to check or do |
| --- | --- |
| Connection refused | Keep the backend running; confirm host, port, and startup logs |
| Database connection or startup failure | Check `MONGO_URI`, MongoDB availability, credentials, network access, and index setup errors |
| 400 invalid request | Read `message`; check required fields, IDs, split totals, dates, and JSON types |
| 401 unauthorized | Log in again and use the new bearer token |
| 403 forbidden | Check active membership and whether the action requires the owner |
| 404 user when adding a member | Register that email first |
| 409 conflict | Use an unused registration email or check whether membership already exists |
| 413 receipt too large | Use a file at or below 10 MB |
| 415 receipt unsupported | Use a genuine JPEG, PNG, WebP, or PDF; renaming an extension does not convert a file |
| 422 receipt unreadable | Use a sharper, well-lit receipt or enter the expense manually |
| 429 scan limit | Wait a minute and retry |
| 503 PDF scan unavailable | Install Poppler and check `PDFTOPPM_PATH` on the backend host |
| 504 scan timeout | Retry with a clearer or smaller receipt, or enter it manually |
| 500 server error | Review backend logs and database connectivity; some invalid model values also produce 500, so check category and status spelling |
| Paid bill missing from balances | Create its shared expense once; bills and expenses are separate |
| Settlement remains after payment | Record the completed payment through the settlement API; verify the correct group and recipient |
| Unexpected balances after removing a member | Calculations include only active members; review historical obligations before removal |

For a failed create request with an uncertain outcome, check the relevant list before resubmitting to avoid duplicates.

## 13. First-use checklist

- Health endpoint responds successfully.
- Two accounts exist and the owner is logged in.
- The group contains both active members and uses the intended currency.
- A test expense shows the expected payer, shares, and balances.
- Receipt values are reviewed before creating any expense.
- Bill status changes and shared expenses are recorded separately as needed.
- External payments are recorded once through the settlement API and reflected in suggestions.

For architecture and maintenance, see [Divvy_Backend_Developer_Guide.md](Divvy_Backend_Developer_Guide.md). For migration details and operational notes, see [README.md](README.md).
