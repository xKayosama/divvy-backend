const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { test, mock } = require('node:test');
const { v2: cloudinary } = require('cloudinary');
const User = require('../src/modules/users/User');
const { changeAvatar } = require('../src/modules/auth/avatar.controller');

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; },
});

test('avatar replacement updates the user before deleting the previous asset', async () => {
  const previous = 'divvy/avatars/previous';
  const req = { user: { _id: 'u', avatarPublicId: previous }, file: { buffer: Buffer.from('image') } };
  const res = response();
  mock.method(cloudinary, 'config', () => ({ cloud_name: 'test', api_key: 'test', api_secret: 'test' }));
  mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.match(options.public_id, /^divvy\/avatars\//);
    assert.equal(options.format, 'webp');
    return new Writable({
      write(chunk, encoding, next) { next(); },
      final(next) {
        callback(null, { secure_url: 'https://example.test/new.webp' });
        next();
      },
    });
  });
  let saved;
  mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.avatarPublicId, previous);
    saved = update.$set;
    return { ...req.user, ...saved };
  });
  const destroy = mock.method(cloudinary.uploader, 'destroy', async (id) => {
    assert.ok(saved.avatar);
    assert.equal(id, previous);
    return { result: 'ok' };
  });
  try {
    await changeAvatar(req, res);
    assert.equal(res.body.data.user.avatar, saved.avatar);
    assert.equal(res.body.data.user.avatarPublicId, undefined);
    assert.equal(destroy.mock.callCount(), 1);
  } finally { mock.restoreAll(); }
});

test('a competing profile update cleans up only the losing upload', async () => {
  const req = { user: { _id: 'u', avatarPublicId: 'previous' }, file: { buffer: Buffer.from('image') } };
  const res = response();
  mock.method(cloudinary, 'config', () => ({ cloud_name: 'test', api_key: 'test', api_secret: 'test' }));
  let uploaded;
  mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    uploaded = options.public_id;
    return new Writable({
      write(chunk, encoding, next) { next(); },
      final(next) { callback(null, { secure_url: 'https://example.test/new.webp' }); next(); },
    });
  });
  mock.method(User, 'findOneAndUpdate', async () => null);
  const destroy = mock.method(cloudinary.uploader, 'destroy', async () => ({ result: 'ok' }));
  try {
    await changeAvatar(req, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(destroy.mock.calls.map(({ arguments: args }) => args[0]), [uploaded]);
  } finally { mock.restoreAll(); }
});
