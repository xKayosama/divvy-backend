const nodemailer = require('nodemailer');
const provider = () => process.env.EMAIL_PROVIDER?.trim().toLowerCase() || 'resend';
const gmailUser = () => process.env.GMAIL_USER?.trim() || '';
const gmailPassword = () => process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '') || '';

// Credentials stay on the backend. Never return or log reset codes.
function isConfigured() {
  if (provider() === 'gmail') return /^[^\s@]+@gmail\.com$/i.test(gmailUser()) && /^[a-z]{16}$/i.test(gmailPassword());
  return provider() === 'resend' && Boolean(process.env.RESEND_API_KEY?.trim() && process.env.PASSWORD_RESET_FROM?.trim());
}
async function sendCode(email, code) {
  return sendEmail(email, 'Reset your Divvy password', `Your Divvy password reset code is ${code}.\n\nIt expires in 15 minutes. Enter it in Divvy to choose a new password. Never share this code. If you did not request this, ignore this email.`);
}
async function sendEmailChangeCode(email, code) {
  return sendEmail(email, 'Verify your new Divvy email', `Your Divvy email verification code is ${code}.\n\nIt expires in 15 minutes. Enter it in Divvy to confirm your new email address. Never share this code. If you did not request this, ignore this email.`);
}
async function sendSignupCode(email, code) {
  return sendEmail(email, 'Verify your Divvy account', `Your Divvy signup verification code is ${code}.\n\nIt expires in 15 minutes. Enter it in Divvy to verify your email before signing in. Never share this code. If you did not create an account, ignore this email.`);
}
async function sendEmail(email, subject, text) {
  if (!isConfigured()) throw new Error('Email delivery is not configured');
  if (provider() === 'gmail') {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: gmailUser(), pass: gmailPassword() },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: { name: 'Divvy', address: gmailUser() }, to: email, subject, text,
      });
      if (!result.accepted?.some(address => String(address).toLowerCase() === email.toLowerCase())) {
        throw new Error('Email delivery failed');
      }
      return;
    } catch {
      // SMTP errors can contain account details; do not expose them to callers or logs.
      throw new Error('Email delivery failed');
    } finally { transport.close(); }
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.PASSWORD_RESET_FROM,
      to: [email],
      subject, text
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Email delivery failed');
}
module.exports = { isConfigured, sendCode, sendEmailChangeCode, sendSignupCode };
