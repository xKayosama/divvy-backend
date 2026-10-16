# Divvy App User Guide

Divvy helps you and your group keep track of shared spending, upcoming bills, and who owes whom. Use this guide for everyday use once the app is connected to the Divvy backend.

This guide follows the planned mobile navigation: **Home, Expenses, Bills, Balances, Settle, and Group**. The current HTML preview uses sample data and does not save changes to the backend. Account, group creation, and logout screen labels may differ in the released app; those steps describe the intended workflow.

## 1. Get started

1. Open the released Divvy app or the app link supplied by its administrator.
2. Choose the option to create an account.
3. Enter your first name, last name, email address, and a password.
4. After registering, log in with your email and password.
5. Create a group, or ask an existing group's owner to add your registered email.

Use the same email when registering and asking to join a group. The current membership process adds existing accounts directly; there is no invitation email to accept.

If your session expires, log in again. Account recovery is not implemented in the current backend; a released app will need a recovery feature before it can offer a working password reset flow.

## 2. Know the main screens

| Screen   | Use it to                                                         |
| -------- | ----------------------------------------------------------------- |
| Home     | Review spending, recent expenses, and upcoming bills              |
| Expenses | Review shared purchases and add expenses                          |
| Bills    | Track obligations, due dates, and payment status                  |
| Balances | See how much each member paid, their share, and their net balance |
| Settle   | See suggested payments between members                            |
| Group    | View members and, as the owner, manage group details              |

Use the **Group selector** to switch between groups. Always check the selected group and currency before saving an expense or bill.

## 3. Set up your group

### Create a group

1. Choose the app's create-group option when available.
2. Enter a clear name, such as “Apartment Expenses” or “Weekend Trip.”
3. Save the group. You become its owner.
4. Open **Group** and check the currency. New groups default to PHP.
5. Set the intended currency before adding expenses.

Changing the currency label later does not convert any existing amounts. Agree on one currency for the group's records.

### Add people

1. Ask each person to register for Divvy first.
2. As the owner, open **Group**.
3. Enter their email in **Add existing user by email**.
4. Tap **Add member**.
5. Check that the person appears as an active member.

Only the owner can change group details, add or remove members, or delete the group. Active members can manage the group's expenses and bills, including entries created by other members. Agree on how your group will handle corrections.

## 4. Add a shared expense

Record an expense when someone has paid for something the group will share.

1. Select the correct group.
2. Tap **+ Expense**.
3. Enter a description, such as “Weekly groceries.”
4. Enter the total paid, using up to two decimal places.
5. Choose a category.
6. In **Paid by**, choose the person who actually paid.
7. Set the actual purchase date.
8. Choose a split type and select the participants who should share the cost.
9. Add optional notes explaining anything unusual.
10. Review the total, payer, participants, and each person's share, then tap **Save expense**.
11. Check the expense list to confirm the entry was saved.

The payer and participants must be active group members. Select the payer as a participant if they should pay a share too. Paying for a purchase does not automatically mean they share its cost.

### Choose the right split

| Split         | When to use it                      | Example for a PHP 1,500 expense    |
| ------------- | ----------------------------------- | ---------------------------------- |
| Equal         | Everyone selected shares equally    | Ana and Ben each owe PHP 750       |
| Exact amounts | People owe specific amounts         | Ana owes PHP 900; Ben owes PHP 600 |
| Percentage    | People owe proportions of the total | Ana owes 60%; Ben owes 40%         |

Exact amounts must add up to the expense total. Percentages must add up to 100%. For equal splits that leave spare cents, the first participant receives the rounding remainder. Percentage splits apply a rounding adjustment to the last participant.

Review the final shares before saving, especially when splitting amounts among three or more people.

## 5. Add an expense from a receipt

1. Tap **+ Expense**.
2. Choose **Scan receipt** to take a photo, or **Upload receipt** to select a file.
3. If prompted, allow camera or file access for the action you selected.
4. Use a clear photo showing the merchant, date, and final total. Avoid glare and cropped edges.
5. Start scanning and wait for the review screen.
6. Compare every extracted value with the original receipt and correct mistakes.
7. Use the reviewed values in the expense form.
8. Choose the category, payer, participants, and split.
9. Review the complete expense and tap **Save expense**.

Supported files are JPEG, PNG, WebP, and PDF, up to 10 MB. PDF scanning reads at most the first three pages and requires PDF support on the server. Scanning may take up to a minute.

Scanning alone does not save an expense. Unreadable fields may be blank, and English receipt recognition can make mistakes. If the receipt uses a different currency from the group, agree on the converted amount before saving; Divvy does not convert it automatically.

The current backend does not retain a permanent receipt attachment or save extracted line items. Keep the original separately if you need it later.

In the current design preview, **Preview scan result** shows demonstration values rather than reading your file. Real scanning requires the app to be connected to the receipt service.

## 6. Review or correct an expense

Open **Expenses**, locate the purchase, and review its amount, payer, date, and split. Use category or date filters if the released app exposes them.

When editing controls are available, open the expense, choose the edit action, correct the details, and save. If you change the total or split type, review every participant's share again. Balances recalculate from the saved expense.

If you entered the same purchase twice, keep one correct entry and delete the duplicate using the expense's delete action when available. Deletion changes balances and has no undo in the current backend.

If a save appears to fail or takes too long, check the expense list before trying again. This helps avoid duplicate records.

## 7. Add and manage bills

A bill tracks something due, such as rent, electricity, or internet. It is separate from a shared expense.

### Add a bill

1. Open **Bills** and tap **+ Bill**.
2. Enter its name, amount, category, and due date.
3. Choose **Pending** for an unpaid bill.
4. Under **Repeat**, choose **Does not repeat**, **Weekly**, **Monthly**, or **Yearly**.
5. Add notes if useful and tap **Save bill**.
6. Check the bill list to confirm the details.

### After paying a bill

Where bill editing is available, open the bill, change its status to **Paid**, select the person who paid, and save.

If other members share the payment, record it once as an expense too. Marking a bill Paid does not add a shared expense or change balances. Check for an existing expense before adding another.

For example, after Ana pays PHP 1,800 for internet, mark the internet bill Paid by Ana. Then create one PHP 1,800 internet expense split between the people sharing the service.

### Understand recurring bills

The first recurring bill represents the first payment due. As due dates arrive, the service generates future pending bills while the backend is running. Paying a bill does not stop its recurring schedule.

To stop repetition, edit the original recurring bill and choose **Does not repeat** when that control is available. Existing generated bills remain. Updating the original affects future generated bills; check existing entries separately if they also need changes. Resuming repetition may generate missed occurrences.

A bill does not automatically switch from Pending to Overdue when its date passes in the current backend. Review past-due bills and update their status when the app offers that action. Automatic reminders and push notifications are not provided by the current backend.

## 8. Understand your balance

Open **Balances** for the selected group.

| Term          | What it means                                       |
| ------------- | --------------------------------------------------- |
| Paid          | How much you paid for recorded shared expenses      |
| Owed or share | Your assigned portion of those expenses             |
| Net balance   | The difference between what you paid and your share |
| Positive net  | You should receive money                            |
| Negative net  | You owe money                                       |
| Zero net      | Your recorded payments equal your assigned shares   |

For example, Ana pays PHP 1,500 for groceries shared equally with Ben. Ana's share is PHP 750, so her net is +PHP 750. Ben paid nothing and has a PHP 750 share, so his net is −PHP 750.

If an amount looks wrong, check the expense list for duplicates, an incorrect payer, missing participants, or an incorrect split. Bills do not contribute to these balances.

## 9. Use suggested settlements

1. Open **Settle**.
2. Read each suggested payment as **person paying → person receiving**.
3. Check the amount and confirm it with the other person.
4. Make the payment separately, such as by cash or a bank transfer.
5. Keep proof of the transfer and a separate record of completed payments.

For the grocery example, the suggestion is **Ben → Ana: PHP 750**.

Divvy does not transfer money. The backend supports recording payments you sent and reviewing payment history. Once a payment is recorded, balances and suggestions update. The HTML preview is still a mockup; until the app provides payment recording, use the settlement API described in the Usage Manual. Record each transfer once and do not enter a reimbursement as another shared purchase.

## 10. Review Home regularly

Use **Home** for a quick overview, then open the full lists when checking details. The backend supplies the latest five expenses and up to five future pending bills for the dashboard.

Past-due pending bills can be absent from the upcoming section. Check **Bills** as well when reviewing unpaid obligations.

A useful routine is to record purchases promptly, review receipts before saving, check unpaid bills weekly, and agree on shared costs before making settlement payments.

## 11. Remove members or delete a group

Before removing someone, review their expenses and outstanding amounts together. Removing a member makes them inactive and removes their group access. Historical expenses remain, but balance calculations include only active members, which can change the displayed result.

As the owner, open **Group**, find the person, and tap **Remove**. Check that you selected the correct person. The owner cannot remove themselves with the current membership controls.

Use **Delete group** only when the group and its records are no longer needed. This permanently deletes its memberships, expenses, and bills. Preserve needed records first; the current backend has no undo or built-in export endpoint.

## 12. Log out

Use the released app's logout option when finished, especially on a shared device. Successful logout invalidates the current session token; other signed-in sessions remain active.

If the app reports a logout failure, retry when connected. If it reports that your session has expired, return to login.

## 13. Solve common problems

| Problem                                     | What to do                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| My group is missing                         | Check the account you used and ask the owner to verify your active membership                       |
| I cannot add someone                        | Only the owner can add members; the person must register first                                      |
| I cannot save a split                       | Select at least one participant; check that exact amounts equal the total or percentages equal 100% |
| The payer is unavailable                    | Ask the owner to check that the person is an active member                                          |
| Receipt values look wrong                   | Correct them during review or enter the expense manually                                            |
| Receipt upload is rejected                  | Use a supported file at or below 10 MB                                                              |
| Receipt scanning is temporarily unavailable | Wait a minute and retry, or enter the expense manually                                              |
| A paid bill does not affect balances        | Record its shared expense once if it should be split                                                |
| A payment suggestion remains after I paid   | Record your payment through the settlement API and check the group and recipient                       |
| A save did not clearly finish               | Reopen the relevant list and check before submitting again                                          |
| Buttons say preview or demo                 | You are using the design mockup; changes are not saved to the backend                               |

## 14. Example of a complete day

Ana and Ben share an apartment group using PHP. Ana buys PHP 1,500 of groceries, selects both people, chooses Equal, and saves. Each owes a PHP 750 share. Ben checks Balances and sees that he owes PHP 750.

Their PHP 1,800 internet bill is still Pending. When Ana pays it, she marks the bill Paid by Ana and records one separate internet expense split equally with Ben. Ana's total net becomes +PHP 1,650, and Ben's becomes −PHP 1,650.

Settle suggests that Ben pay Ana PHP 1,650. Ben transfers the money outside Divvy, and they keep the payment confirmation separately. Ben records the payment through the settlement API, which clears the remaining suggestion.

For installation and API operation, see the [Divvy Usage Manual](Divvy_Usage_Manual.md).
