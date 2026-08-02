const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('GPDBENC1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveFileKey(secret) {
  const source = String(secret || '').trim();
  if (source.length < 32) return null;
  return crypto.createHash('sha256').update(source, 'utf8').digest();
}

async function encryptFile(sourcePath, destinationPath, secret) {
  const key = deriveFileKey(secret);
  if (!key) throw new Error('Backup encryption key must contain at least 32 characters');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const destination = fs.createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 });
  destination.write(MAGIC);
  destination.write(iv);
  try {
    await pipeline(fs.createReadStream(sourcePath), cipher, destination, { end: false });
    await new Promise((resolve, reject) => {
      destination.end(cipher.getAuthTag(), (error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    destination.destroy();
    try { fs.unlinkSync(destinationPath); } catch (_unlinkError) {}
    throw error;
  }
  return destinationPath;
}

function decryptFileBuffer(encryptedBuffer, secret) {
  const key = deriveFileKey(secret);
  if (!key) throw new Error('Backup encryption key must contain at least 32 characters');
  const input = Buffer.from(encryptedBuffer || []);
  const minimumLength = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (input.length < minimumLength || !input.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid encrypted backup format');
  }
  const ivStart = MAGIC.length;
  const bodyStart = ivStart + IV_BYTES;
  const tagStart = input.length - TAG_BYTES;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, input.subarray(ivStart, bodyStart));
  decipher.setAuthTag(input.subarray(tagStart));
  return Buffer.concat([decipher.update(input.subarray(bodyStart, tagStart)), decipher.final()]);
}

module.exports = { encryptFile, decryptFileBuffer, deriveFileKey, MAGIC };
