function buildSpendingComparison(expenses, selection) {
  const { period, start, end } = selection;
  if (!start) return null;
  const previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  let currentCents = 0;
  let previousCents = 0;
  for (const expense of expenses) {
    const date = new Date(expense.date);
    const cents = Math.round(expense.amount * 100);
    if (date >= start && date < end) currentCents += cents;
    else if (date >= previousStart && date < start) previousCents += cents;
  }
  const differenceCents = currentCents - previousCents;
  return {
    timeZone: 'UTC',
    basis: 'calendar_month',
    current: {
      startDate: period.startDate,
      endDate: period.endDate,
      amount: currentCents / 100,
      isInProgress: period.value === 'this_month'
    },
    previous: {
      startDate: previousStart.toISOString().slice(0, 10),
      endDate: new Date(start.getTime() - 1).toISOString().slice(0, 10),
      amount: previousCents / 100
    },
    difference: differenceCents / 100,
    percentageChange: previousCents > 0 ? Math.round(differenceCents / previousCents * 10000) / 100 : null,
    direction: differenceCents > 0 ? 'increase' : differenceCents < 0 ? 'decrease' : 'unchanged'
  };
}

module.exports = { buildSpendingComparison };
