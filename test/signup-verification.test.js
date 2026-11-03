const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/modules/users/User');
const bcrypt = require('bcryptjs');
const delivery = require('../src/modules/auth/password-reset.email');
const verification = require('../src/modules/auth/signup-verification');
const { register, login } = require('../src/modules/auth/auth.controller');
process.env.JWT_SECRET = 'signup-test-secret';
afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const email = 'ada@example.com';
const body = { firstName: 'Ada', lastName: 'Lovelace', email: ' ADA@example.com ', password: 'password123' };
test('signup creates an unverified account and sends only the email its code', async () => {
  mock.method(User, 'findOne', async () => null);
  mock.method(delivery, 'isConfigured', () => true);
  mock.method(bcrypt, 'hash', async () => 'hashed');
  mock.method(User, 'create', async data => { assert.equal(data.emailVerified, false); assert.equal(data.email, email); return { ...data, _id: 'u1' }; });
  let stored;
  mock.method(User, 'findOneAndUpdate', async (filter, update) => { assert.equal(filter.emailVerified, false); stored = update.$set.signupVerification; return { _id: 'u1' }; });
  mock.method(delivery, 'sendSignupCode', async (to, code) => {
    assert.equal(to, email); assert.match(code, /^\d{8}$/);
    assert.equal(stored.codeHash, verification.hashCode(email, code));
    assert.equal(stored.attempts, 0); assert.equal(stored.expiresAt - stored.requestedAt, 900000);
  });
  const res = response(); await register({ body }, res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.data.requiresEmailVerification, true);
  assert.equal(res.body.data.emailSent, true); assert.equal(res.body.data.token, undefined);
  assert.equal(JSON.stringify(res.body).includes(stored.codeHash), false);
});
test('signup refuses to create an account when email delivery is not configured', async () => {
  mock.method(User, 'findOne', async () => null); mock.method(delivery, 'isConfigured', () => false);
  mock.method(User, 'create', async () => assert.fail('must not create'));
  const res = response(); await register({ body }, res); assert.equal(res.statusCode, 503);
});
test('unverified account cannot log in with the correct password', async () => {
  mock.method(User, 'findOne', async () => ({ _id: 'u1', password: 'hashed', emailVerified: false }));
  mock.method(bcrypt, 'compare', async () => true);
  const res = response(); await login({ body: { email, password: 'password123' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED'); assert.equal(res.body.data, undefined);
});
test('delivery failure removes only the issued code and allows recovery', async () => {
  mock.method(delivery, 'isConfigured', () => true);
  mock.method(User, 'findOneAndUpdate', async () => ({ _id: 'u1' }));
  mock.method(delivery, 'sendSignupCode', async () => { throw Error('provider unavailable'); });
  mock.method(User, 'updateOne', async (filter, update) => { assert.ok(filter['signupVerification.codeHash']); assert.deepEqual(update, { $unset: { signupVerification: 1 } }); });
  assert.equal(await verification.issueCode(email), false);
});
test('resend cooldown does not send another code', async () => {
  mock.method(delivery, 'isConfigured', () => true);
  mock.method(User, 'findOneAndUpdate', async filter => { assert.ok(filter.$or[1]['signupVerification.requestedAt'].$lte); return null; });
  mock.method(delivery, 'sendSignupCode', async () => assert.fail('must not send'));
  assert.equal(await verification.issueCode(email), true);
});
test('valid verification atomically consumes the code and enables login', async () => {
  const hash = verification.hashCode(email, '12345678');
  mock.method(User, 'findOneAndUpdate', (filter, update) => {
    assert.equal(filter.emailVerified, false); assert.deepEqual(filter['signupVerification.attempts'], { $lt: 5 });
    assert.ok(filter['signupVerification.expiresAt'].$gt); assert.equal(update.$inc['signupVerification.attempts'], 1);
    return { select: async () => ({ _id: 'u1', signupVerification: { codeHash: hash } }) };
  });
  mock.method(User, 'updateOne', async (filter, update) => {
    assert.equal(filter['signupVerification.codeHash'], hash); assert.ok(filter['signupVerification.expiresAt'].$gt);
    assert.deepEqual(update, { $set: { emailVerified: true }, $unset: { signupVerification: 1 } }); return { modifiedCount: 1 };
  });
  const res = response(); await verification.verify({ body: { email, code: '12345678' } }, res); assert.equal(res.statusCode, 200);
});
for (const scenario of ['wrong', 'expired or exhausted', 'already consumed']) test(`verification rejects ${scenario} codes`, async () => {
  mock.method(User, 'findOneAndUpdate', () => ({ select: async () => scenario === 'expired or exhausted' ? null : { _id: 'u1', signupVerification: { codeHash: verification.hashCode(email, scenario === 'wrong' ? '99999999' : '12345678') } } }));
  mock.method(User, 'updateOne', async () => { assert.equal(scenario, 'already consumed'); return { modifiedCount: 0 }; });
  const res = response(); await verification.verify({ body: { email, code: '12345678' } }, res); assert.equal(res.statusCode, 400);
});
test('verified accounts can sign in', async () => {
  mock.method(User, 'findOne', async () => ({ _id: 'u1', email, password: 'hashed', emailVerified: true }));
  mock.method(bcrypt, 'compare', async () => true);
  const res = response(); await login({ body: { email, password: 'password123' } }, res);
  assert.equal(res.statusCode, 200); assert.ok(res.body.data.token);
});
test('pending accounts cannot access protected routes even with a signed token', async () => {
  const { protect } = require('../src/modules/auth/auth.middleware');
  const { generateToken } = require('../src/modules/auth/jwt');
  mock.method(require('../src/modules/auth/RevokedToken'), 'exists', async () => false);
  mock.method(User, 'findById', () => ({ select: async () => ({ _id: 'u1', emailVerified: false }) }));
  const res = response(); await protect({ headers: { authorization: `Bearer ${generateToken('u1')}` } }, res, () => assert.fail('must not grant access'));
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED');
});
