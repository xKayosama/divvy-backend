async function post(path, body) {
  const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('PUSH_SERVICE_UNAVAILABLE');
  const result = await response.json();
  if (result.errors?.length) throw new Error('PUSH_SERVICE_UNAVAILABLE');
  return result.data;
}
async function send(message) {
  const data = await post('send', message);
  const ticket = Array.isArray(data) ? data[0] : data;
  if (!ticket || !['ok', 'error'].includes(ticket.status)) throw new Error('PUSH_SERVICE_UNAVAILABLE');
  return ticket;
}
async function receipt(id) { return (await post('getReceipts', { ids: [id] }))?.[id] || null; }
module.exports = { send, receipt };
