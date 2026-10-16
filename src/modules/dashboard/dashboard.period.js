// UTC calendar months match the expense date-range and bill-date contracts.
function resolveDashboardPeriod(value = 'all_time', now = new Date()) {
  if (typeof value !== 'string' || !['all_time', 'this_month', 'last_month'].includes(value)) {
    throw new RangeError('period must be all_time, this_month, or last_month.');
  }
  if (value === 'all_time') {
    return { period: { value, timeZone: 'UTC', startDate: null, endDate: null }, start: null, end: null };
  }
  const offset = value === 'last_month' ? -1 : 0;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return {
    period: {
      value,
      timeZone: 'UTC',
      startDate: start.toISOString().slice(0, 10),
      endDate: new Date(end.getTime() - 1).toISOString().slice(0, 10)
    },
    start,
    end
  };
}

module.exports = { resolveDashboardPeriod };
