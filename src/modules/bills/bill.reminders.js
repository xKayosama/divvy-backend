const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;
const PREVIEW_LIMIT = 5;

function dayWindow(now = new Date()) {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  return {
    today,
    tomorrow: new Date(today.getTime() + DAY_MS),
    // Tomorrow through the seventh day, including that entire day.
    end: new Date(today.getTime() + (WINDOW_DAYS + 1) * DAY_MS)
  };
}

function effectiveStatus(bill, now = new Date()) {
  if (bill.status === 'PAID') return 'PAID';
  return new Date(bill.dueDate) < dayWindow(now).today ? 'OVERDUE' : 'PENDING';
}

// Serialize without mutating Mongoose documents or persisting derived status.
function presentBill(bill, now = new Date()) {
  const record = typeof bill.toObject === 'function' ? bill.toObject() : { ...bill };
  return { ...record, paidAt: record.paidAt ?? null, status: effectiveStatus(record, now) };
}

function statusFilter(status, now = new Date()) {
  if (status === 'PAID') return { status: 'PAID' };
  const { today } = dayWindow(now);
  return {
    status: { $ne: 'PAID' },
    dueDate: status === 'OVERDUE' ? { $lt: today } : { $gte: today }
  };
}

function buildBillReminders(bills, now = new Date()) {
  const { today, tomorrow, end } = dayWindow(now);
  const groups = { overdue: [], dueToday: [], dueSoon: [] };
  for (const bill of bills) {
    if (bill.status === 'PAID') continue;
    const due = new Date(bill.dueDate);
    if (due < today) groups.overdue.push(bill);
    else if (due < tomorrow) groups.dueToday.push(bill);
    else if (due < end) groups.dueSoon.push(bill);
  }
  const result = { asOf: new Date(now).toISOString(), timeZone: 'UTC', windowDays: WINDOW_DAYS };
  for (const [name, entries] of Object.entries(groups)) {
    entries.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate) || String(a._id).localeCompare(String(b._id)));
    result[name] = {
      count: entries.length,
      amount: Number(entries.reduce((sum, bill) => sum + Math.round(bill.amount * 100), 0) / 100),
      bills: entries.slice(0, PREVIEW_LIMIT).map(bill => presentBill(bill, now))
    };
  }
  return result;
}

module.exports = { dayWindow, effectiveStatus, presentBill, statusFilter, buildBillReminders };
