const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/modules/users/User');
const { register, login } = require('../src/modules/auth/auth.controller');
const { validateEnvironment } = require('../src/config/environment');
const app = require('../src/app');

afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('startup rejects absent secrets, invalid ports and expired token durations', () => {
  const env = { MONGO_URI: 'mongodb://localhost/divvy', JWT_SECRET: 'a'.repeat(32) };
  assert.deepEqual(validateEnvironment(env), { port: 5000 });
  for (const overrides of [{ MONGO_URI: '' }, { JWT_SECRET: 'short' }, { PORT: '0' }, { PORT: 'abc' }, { JWT_EXPIRES_IN: '-1s' }, { JWT_EXPIRES_IN: 'invalid' }]) {
    assert.throws(() => validateEnvironment({ ...env, ...overrides }));
  }
});

test('invalid registration is rejected before database queries or password hashing', async () => {
  mock.method(User, 'findOne', () => assert.fail('must not query'));
  mock.method(bcrypt, 'hash', () => assert.fail('must not hash'));
  const valid = { firstName: 'Test', lastName: 'User', email: 'test@example.com', password: 'password123' };
  for (const body of [undefined, {}, { ...valid, password: 'short' }, { ...valid, password: '😀'.repeat(19) }, { ...valid, email: {} }, { ...valid, firstName: ' ' }, { ...valid, email: 'invalid' }]) {
    const res = response();
    await register({ body }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('registration normalizes email and handles duplicate creation races', async () => {
  mock.method(User, 'findOne', async filter => { assert.equal(filter.email, 'test@example.com'); return null; });
  mock.method(bcrypt, 'hash', async () => 'hash');
  mock.method(User, 'create', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  const res = response();
  await register({ body: { firstName: 'Test', lastName: 'User', email: ' TEST@example.com ', password: 'password123' } }, res);
  assert.equal(res.statusCode, 409);
});

test('login rejects structured credentials but preserves legacy short passwords', async () => {
  mock.method(User, 'findOne', async () => null);
  for (const body of [undefined, { email: {}, password: 'pass' }, { email: 'test@example.com', password: {} }]) {
    const res = response(); await login({ body }, res); assert.equal(res.statusCode, 400);
  }
  const res = response(); await login({ body: { email: 'test@example.com', password: 'short' } }, res); assert.equal(res.statusCode, 401);
});

test('readiness reflects database ping failures and shutdown while health remains live', async () => {
  const handler = app.router.stack.find(layer => layer.route?.path === '/api/ready').route.stack[0].handle;
  const originalDb = mongoose.connection.db;
  const originalState = mongoose.connection.readyState;
  try {
    mongoose.connection.readyState = 0;
    let res = response(); await handler({ app }, res); assert.equal(res.statusCode, 503);
    mongoose.connection.readyState = 1;
    mongoose.connection.db = { admin: () => ({ ping: async () => {} }) };
    res = response(); await handler({ app }, res); assert.equal(res.statusCode, 200);
    mongoose.connection.db = { admin: () => ({ ping: async () => { throw new Error('offline'); } }) };
    res = response(); await handler({ app }, res); assert.equal(res.statusCode, 503);
    app.locals.shuttingDown = true;
    res = response(); await handler({ app }, res); assert.equal(res.statusCode, 503);
  } finally {
    mongoose.connection.db = originalDb;
    mongoose.connection.readyState = originalState;
    delete app.locals.shuttingDown;
  }
});

test('login and registration reject excess attempts with JSON and retry headers', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    for (const [route, limit] of [['login', 20], ['register', 5]]) {
      for (let attempt = 0; attempt < limit; attempt++) {
        const res = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 400);
        await res.text();
      }
      const res = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 429);
      assert.ok(res.headers.get('retry-after'));
      assert.equal((await res.json()).success, false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
