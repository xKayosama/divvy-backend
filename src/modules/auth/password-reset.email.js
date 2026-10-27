// Credentials stay on the backend. Never return or log reset codes.
function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.PASSWORD_RESET_FROM?.trim());
}
async function sendCode(email, code) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.PASSWORD_RESET_FROM,
      to: [email],
      subject: 'Reset your Divvy password',
      text: `Your Divvy password reset code is ${code}.\n\nIt expires in 15 minutes. Enter it in Divvy to choose a new password. Never share this code. If you did not request this, ignore this email.`
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Reset email delivery failed');
}
module.exports = { isConfigured, sendCode };
