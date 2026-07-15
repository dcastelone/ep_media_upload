'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'ep_etherpad-lite/node/eejs/') return {require: () => ''};
  if (request === 'ep_etherpad-lite/node/utils/Settings') return {};
  if (request === 'ep_etherpad-lite/node/db/SecurityManager') return {checkAccess: async () => ({accessStatus: 'deny'})};
  if (request === '@aws-sdk/client-s3') return {};
  if (request === '@aws-sdk/s3-request-presigner') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {__testValidation: validation} = require('../index');
Module._load = originalLoad;

test('pad IDs permit Etherpad group syntax but reject traversal and controls', () => {
  for (const value of ['pad-1', 'g.abc123$assignment', 'wiki:week_1', '日本語']) {
    assert.equal(validation.isValidPadId(value), true, value);
  }
  for (const value of ['', null, '../secret', 'a/b', 'a\\b', 'bad\0id', `bad\nline`, 'x'.repeat(501)]) {
    assert.equal(validation.isValidPadId(value), false, String(value));
  }
});

test('extensions are normalized and missing extensions are rejected', () => {
  assert.equal(validation.getValidExtension('Report.Final.PDF'), 'pdf');
  assert.equal(validation.getValidExtension('.env'), null);
  assert.equal(validation.getValidExtension('no-extension'), null);
  assert.equal(validation.getValidExtension(null), null);
});

test('known extensions require matching MIME types', () => {
  assert.equal(validation.isValidMimeForExtension('png', 'image/png'), true);
  assert.equal(validation.isValidMimeForExtension('txt', 'text/plain; charset=utf-8'), true);
  assert.equal(validation.isValidMimeForExtension('pdf', 'text/html'), false);
  assert.equal(validation.isValidMimeForExtension('svg', 'text/html'), false);
  assert.equal(validation.isValidMimeForExtension('unknown', 'application/octet-stream'), true);
  assert.equal(validation.isValidMimeForExtension('', 'image/png'), false);
});

test('download file IDs require a UUID and safe alphanumeric extension', () => {
  const valid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf';
  assert.equal(validation.isValidFileId(valid), true);
  for (const value of ['', null, '../' + valid, valid + '/x', 'not-a-uuid.pdf', valid.replace('.pdf', '.tar.gz'), valid.replace('.pdf', '.p$d')]) {
    assert.equal(validation.isValidFileId(value), false, String(value));
  }
});
