const crypto = require('crypto');

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || 'insecure_dev_key_change_me_32bytes!!';
  // Derive a stable 32-byte key from whatever string is provided
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined) return null;
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payload) {
  if (!payload) return null;
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// Masks a secret for display purposes (never send full secret to client)
function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
