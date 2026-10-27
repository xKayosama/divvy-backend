const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const User = require('../src/modules/users/User');
const delivery = require('../src/modules/auth/password-reset.email');
const { requestPasswordReset, resetPassword, hashCode } = require('../src/modules/auth/password-reset.controller');
const { generateToken } = require('../src/modules/auth/jwt');
const { protect } = require('../src/modules/auth/auth.middleware');
const RevokedToken = require('../src/modules/auth/RevokedToken');
const routes = require('../src/modules/auth/auth.routes');
process.env.JWT_SECRET = 'password-reset-test-secret-at-least-32-bytes';
afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const email = 'test@example.com';
const code = '01234567';
const body = { email, code, password: 'new-password-123' };

function memoryAccount() {
  const user = { _id: 'u1', email, password: 'old-hash', authVersion: 0 };
  mock.method(User, 'findOneAndUpdate', (filter, update) => {
    let match = filter.email === user.email;
    if (filter.$or) match &&= !user.passwordReset || user.passwordReset.requestedAt <= filter.$or[1]['passwordReset.requestedAt'].$lte;
    else match &&= Boolean(user.passwordReset && user.passwordReset.expiresAt > filter['passwordReset.expiresAt'].$gt && user.passwordReset.attempts < filter['passwordReset.attempts'].$lt);
    if (match) {
      if (update.$set) user.passwordReset = update.$set.passwordReset;
      else user.passwordReset.attempts += 1;
    }
    const snapshot = match ? structuredClone(user) : null;
    return { then(resolve) { return Promise.resolve(snapshot).then(resolve); }, select: async () => snapshot };
  });
  mock.method(User, 'updateOne', async (filter, update) => {
    const matches = user.passwordReset?.codeHash === filter['passwordReset.codeHash'] &&
      (!filter['passwordReset.expiresAt'] || user.passwordReset.expiresAt > filter['passwordReset.expiresAt'].$gt);
    if (!matches) return { modifiedCount: 0 };
    if (update.$set) { user.password = update.$set.password; user.authVersion += update.$inc.authVersion; }
    delete user.passwordReset;
    return { modifiedCount: 1 };
  });
  user.passwordReset = { codeHash: hashCode(email, code), expiresAt: new Date(Date.now() + 900000), requestedAt: new Date(Date.now() - 61000), attempts: 0 };
  return user;
}

test('reset routes are public POST routes with separate limiters', () => {
  for (const path of ['/forgot-password', '/reset-password']) {
    const route = routes.stack.find(layer => layer.route?.path === path).route;
    assert.equal(route.methods.post, true);
    assert.equal(route.stack.length, 2);
    assert.notEqual(route.stack[0].handle, protect);
  }
});

test('request normalizes email, sends an 8-digit code, stores only its keyed hash and throttles resends', async () => {
  const user = memoryAccount();
  mock.method(delivery, 'isConfigured', () => true);
  let sent;
  mock.method(delivery, 'sendCode', async (to, value) => { assert.equal(to, email); sent = value; });
  let res = response();
  await requestPasswordReset({ body: { email: ' TEST@example.com ' } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(sent, /^\d{8}$/);
  assert.equal(user.passwordReset.codeHash, hashCode(email, sent));
  assert.notEqual(user.passwordReset.codeHash, sent);
  assert.equal(user.passwordReset.expiresAt - user.passwordReset.requestedAt, 900000);
  const previous = sent;
  res = response(); await requestPasswordReset({ body: { email } }, res);
  assert.equal(sent, previous);
  assert.equal(delivery.sendCode.mock.callCount(), 1);
});

test('unknown email and an existing account return identical responses', async () => {
  memoryAccount(); mock.method(delivery, 'isConfigured', () => true); mock.method(delivery, 'sendCode', async () => {});
  const known = response(); const unknown = response();
  await requestPasswordReset({ body: { email } }, known);
  await requestPasswordReset({ body: { email: 'unknown@example.com' } }, unknown);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(delivery.sendCode.mock.callCount(), 1);
});

test('unconfigured email fails globally before querying accounts', async () => {
  mock.method(delivery, 'isConfigured', () => false);
  mock.method(User, 'findOneAndUpdate', () => assert.fail('must not query'));
  const res = response(); await requestPasswordReset({ body: { email } }, res);
  assert.equal(res.statusCode, 503);
});

test('delivery failure clears only the issued code and returns the generic response', async () => {
  const user = memoryAccount(); mock.method(delivery, 'isConfigured', () => true);
  mock.method(delivery, 'sendCode', async () => { throw Error('provider failed'); }); mock.method(console, 'error', () => {});
  const res = response(); await requestPasswordReset({ body: { email } }, res);
  assert.equal(res.statusCode, 200); assert.equal(user.passwordReset, undefined);
});

test('valid reset hashes password, consumes code, and invalidates existing JWTs while fresh login works', async () => {
  const user = memoryAccount();
  const oldToken = generateToken('u1');
  const res = response(); await resetPassword({ body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(await bcrypt.compare(body.password, user.password), true);
  assert.equal(user.authVersion, 1); assert.equal(user.passwordReset, undefined);
  mock.method(RevokedToken, 'exists', async () => false);
  mock.method(User, 'findById', () => ({ select: async () => user }));
  for (const [token, expected] of [[oldToken, false], [generateToken('u1', user.authVersion), true]]) {
    let allowed = false; const authRes = response();
    await protect({ headers: { authorization: `Bearer ${token}` } }, authRes, () => { allowed = true; });
    assert.equal(allowed, expected);
  }
  const replay = response(); await resetPassword({ body }, replay); assert.equal(replay.statusCode, 400);
});

test('expired codes, missing accounts, and a sixth attempt fail without changing the password', async () => {
  const user = memoryAccount();
  user.passwordReset.expiresAt = new Date(Date.now() - 1);
  let res = response(); await resetPassword({ body }, res); assert.equal(res.statusCode, 400);
  user.passwordReset.expiresAt = new Date(Date.now() + 900000);
  for (let i = 0; i < 5; i++) { res = response(); await resetPassword({ body: { ...body, code: '99999999' } }, res); assert.equal(res.statusCode, 400); }
  assert.equal(user.passwordReset.attempts, 5);
  res = response(); await resetPassword({ body }, res); assert.equal(res.statusCode, 400);
  assert.equal(user.password, 'old-hash');
  res = response(); await resetPassword({ body: { ...body, email: 'unknown@example.com' } }, res); assert.equal(res.statusCode, 400);
});

test('two concurrent resets cannot consume one code twice', async () => {
  const user = memoryAccount(); const results = [response(), response()];
  await Promise.all(results.map(res => resetPassword({ body }, res)));
  assert.deepEqual(results.map(res => res.statusCode).sort(), [200, 400]); assert.equal(user.authVersion, 1);
});

test('malformed input and excessive UTF-8 passwords are rejected before database access', async () => {
  mock.method(User, 'findOneAndUpdate', () => assert.fail('must not query'));
  for (const input of [undefined, {}, { ...body, email: {} }, { ...body, code: {} }, { ...body, code: '123' }, { ...body, password: 'short' }, { ...body, password: '😀'.repeat(19) }]) {
    const res = response(); await resetPassword({ body: input }, res); assert.equal(res.statusCode, 400);
  }
  const res = response(); await requestPasswordReset({ body: { email: {} } }, res); assert.equal(res.statusCode, 400);
});

test('email transport sends the code only to Resend with bounded timeout and rejects provider failures', async () => {
  const original = global.fetch; const key = process.env.RESEND_API_KEY; const sender = process.env.PASSWORD_RESET_FROM;
  process.env.RESEND_API_KEY = 'test-key'; process.env.PASSWORD_RESET_FROM = 'Divvy <reset@example.com>';
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options.headers.Authorization, 'Bearer test-key');
      const payload = JSON.parse(options.body); assert.deepEqual(payload.to, [email]); assert.ok(payload.text.includes(code)); assert.ok(options.signal); return { ok: true };
    };
    await delivery.sendCode(email, code);
    global.fetch = async () => ({ ok: false });
    await assert.rejects(delivery.sendCode(email, code));
  } finally {
    global.fetch = original;
    if (key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = key;
    if (sender === undefined) delete process.env.PASSWORD_RESET_FROM; else process.env.PASSWORD_RESET_FROM = sender;
  }
});
