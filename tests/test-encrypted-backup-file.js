#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encryptFile, decryptFileBuffer, MAGIC } = require('../utils/encryptedFile');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildpilot-encrypted-backup-'));
  const source = path.join(dir, 'source.db');
  const destination = path.join(dir, 'source.db.enc');
  const key = 'backup-test-key-that-is-at-least-32-characters';
  const plaintext = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x5a)]);

  try {
    fs.writeFileSync(source, plaintext);
    await encryptFile(source, destination, key);
    const encrypted = fs.readFileSync(destination);
    assert(encrypted.subarray(0, MAGIC.length).equals(MAGIC));
    assert.strictEqual(encrypted.includes(Buffer.from('SQLite format 3')), false, 'SQLite header must not remain visible');
    assert(decryptFileBuffer(encrypted, key).equals(plaintext));
    assert.throws(() => decryptFileBuffer(encrypted, `${key}-wrong`), /authenticate|Unsupported state/i);
    console.log('encrypted backup file assertions passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
