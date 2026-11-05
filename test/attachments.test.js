const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const GroupMember = require('../src/modules/groups/GroupMember');
const { registerAttachments } = require('../src/modules/attachments/attachment.routes');

test('private attachment routes enforce active membership, one file, and management permissions', async (t) => {
  const member = 'member';
  let active = true;
  let role = 'MEMBER';
  let attachment;
  let attachmentBytes;
  const recordQuery = () => ({
    select() { return this; },
    lean() { return this; },
    then(resolve) { return Promise.resolve({ attachment, attachmentBytes }).then(resolve); },
  });
  const model = {
    findOne: recordQuery,
    findOneAndUpdate(scope, update) {
      assert.equal(scope.groupId, 'group');
      if (scope.$or && attachment && attachment.uploadedBy !== member) {
        return { select() { return this; }, lean: async () => null };
      }
      attachment = update.$set?.attachment;
      attachmentBytes = update.$set?.attachmentBytes;
      return recordQuery();
    },
  };
  t.mock.method(GroupMember, 'findOne', (filter) => {
    assert.deepEqual(filter, { groupId: 'group', userId: member, status: 'ACTIVE' });
    return { select: async () => active ? { role } : null };
  });
  const app = express();
  registerAttachments(app, model, 'id', (req, res, next) => {
    req.user = { _id: member };
    next();
  }, (req, res, next) => {
    req.group = { _id: 'group' };
    next();
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/record/attachment`;
  const pdf = '%PDF-1.4 fixture';
  const form = (contents, count = 1) => {
    const data = new FormData();
    for (let i = 0; i < count; i++) {
      data.append('attachment', new Blob([contents], { type: 'application/pdf' }), 'receipt.pdf');
    }
    return data;
  };

  assert.equal((await fetch(url, { method: 'PUT', body: form('fake pdf') })).status, 415);
  assert.equal((await fetch(url, { method: 'PUT', body: form(pdf, 2) })).status, 400);
  const upload = await fetch(url, { method: 'PUT', body: form(pdf) });
  assert.equal(upload.status, 200);
  assert.deepEqual((await upload.json()).data, {
    attachment: { name: 'receipt.pdf', size: Buffer.byteLength(pdf) }, canManage: true,
  });

  attachment.uploadedBy = 'another-member';
  const download = await fetch(`${url}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await download.text(), pdf);
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 409);
  active = false;
  assert.equal((await fetch(`${url}/download`)).status, 403);
  active = true;
  role = 'OWNER';
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${url}/download`)).status, 404);
});
