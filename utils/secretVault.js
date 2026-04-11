const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

function getMasterKey() {
  const source = String(process.env.SUPERADMIN_SECRET_KEY || process.env.SESSION_SECRET || '').trim();
  if (!source) return null;
  return crypto.createHash('sha256').update(source, 'utf8').digest();
}

function encryptSecret(value) {
  const plaintext = String(value || '');
  if (!plaintext) return '';
  const key = getMasterKey();
  if (!key) return '';

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return '';
  const key = getMasterKey();
  if (!key) return '';

  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return '';

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const encrypted = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (_error) {
    return '';
  }
}

function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

module.exports = {
  decryptSecret,
  encryptSecret,
  maskSecret,
};
