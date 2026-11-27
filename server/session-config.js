'use strict';

// Staff sessions last for at least 24 hours. With rolling cookies enabled,
// active sessions receive a fresh 24-hour inactivity window on each request.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getSessionExpiry(sessionData, now = Date.now()) {
  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const timestamp = new Date(expires).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }

  const maxAge = Number(sessionData?.cookie?.maxAge);
  return now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : SESSION_TTL_MS);
}

module.exports = { SESSION_TTL_MS, getSessionExpiry };
