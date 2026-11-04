const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const delivery = require('../src/modules/auth/password-reset.email');
const keys = ['EMAIL_PROVIDER', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'RESEND_API_KEY', 'PASSWORD_RESET_FROM'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
afterEach(() => {
  mock.restoreAll();
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
});
function gmail() {
  process.env.EMAIL_PROVIDER = 'gmail';
  process.env.GMAIL_USER = 'divvy-test@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
}
test('provider configuration fails closed and preserves legacy Resend configuration', () => {
  gmail(); assert.equal(delivery.isConfigured(), true);
  process.env.GMAIL_APP_PASSWORD = ''; assert.equal(delivery.isConfigured(), false);
  process.env.RESEND_API_KEY = 'key'; process.env.PASSWORD_RESET_FROM = 'sender@example.com';
  assert.equal(delivery.isConfigured(), false);
  process.env.EMAIL_PROVIDER = 'unknown'; assert.equal(delivery.isConfigured(), false);
  delete process.env.EMAIL_PROVIDER; assert.equal(delivery.isConfigured(), true);
});
test('all account email flows use Gmail TLS with the actual recipient and correct subject', async () => {
  gmail();
  const messages = [];
  let closed = 0;
  mock.method(global, 'fetch', async () => assert.fail('must not use Resend'));
  mock.method(nodemailer, 'createTransport', options => {
    assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.port, 465); assert.equal(options.secure, true);
    assert.deepEqual(options.auth, { user: 'divvy-test@gmail.com', pass: 'abcdefghijklmnop' });
    assert.equal(options.connectionTimeout, 8000); assert.equal(options.greetingTimeout, 8000); assert.equal(options.socketTimeout, 8000);
    return { sendMail: async message => { messages.push(message); return { accepted: [message.to] }; }, close() { closed++; } };
  });
  await delivery.sendSignupCode('signup@example.com', '12345678');
  await delivery.sendCode('reset@example.com', '87654321');
  await delivery.sendEmailChangeCode('change@example.com', '11223344');
  assert.deepEqual(messages.map(message => message.to), ['signup@example.com', 'reset@example.com', 'change@example.com']);
  assert.deepEqual(messages.map(message => message.subject), ['Verify your Divvy account', 'Reset your Divvy password', 'Verify your new Divvy email']);
  assert.deepEqual(messages[0].from, { name: 'Divvy', address: 'divvy-test@gmail.com' });
  assert.match(messages[0].text, /12345678/); assert.match(messages[0].text, /15 minutes/); assert.equal(closed, 3);
});
for (const mode of ['rejection', 'smtp error']) test(`Gmail ${mode} reports failure without credentials or fallback`, async () => {
  gmail(); let closed = false;
  mock.method(global, 'fetch', async () => assert.fail('must not fall back'));
  mock.method(nodemailer, 'createTransport', () => ({
    async sendMail() { if (mode === 'smtp error') throw new Error('private-account-and-password'); return { accepted: [], rejected: ['recipient@example.com'] }; },
    close() { closed = true; }
  }));
  await assert.rejects(delivery.sendSignupCode('recipient@example.com', '12345678'), { message: 'Email delivery failed' });
  assert.equal(closed, true);
});
test('missing Gmail credentials never open an SMTP connection', async () => {
  gmail(); process.env.GMAIL_APP_PASSWORD = '';
  mock.method(nodemailer, 'createTransport', () => assert.fail('must not connect'));
  await assert.rejects(delivery.sendSignupCode('recipient@example.com', '12345678'), /not configured/);
});
