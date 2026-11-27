'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters.');
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);

  return `scrypt$16384$8$1$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' ||
      parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1') {
    return false;
  }

  if (!/^[0-9a-f]{32}$/i.test(parts[4]) ||
      !/^[0-9a-f]{128}$/i.test(parts[5])) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    const actual = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);

    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
