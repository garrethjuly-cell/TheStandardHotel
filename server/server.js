require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { SESSION_TTL_MS } = require('./session-config');
const SQLiteSessionStore = require('./sqlite-session-store');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Paynow } = require('paynow');
const db = require('./database');
const { verifyPassword, hashPassword } = require('./auth-security');
const { sendEnquiryNotifications, sendEnquiryAlarmControl } = require('./push-notifications');
const { installResetManager } = require('./reset-manager');
const { installEnquiryCleanup } = require('./enquiry-cleanup');
const { DEVICE_ID_PATTERN, DeviceRegistrationError, getDeviceAlarmState, updateEnquiryStatus, dismissDeviceAlarm } = require('./enquiry-alarm-service');
const { installWhatsAppWebhook } = require('./whatsapp-webhook');
const { installWhatsAppReply } = require('./whatsapp-reply');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
if (process.env.NODE_ENV === 'production' && !PUBLIC_BASE_URL.startsWith('https://')) {
  throw new Error('PUBLIC_BASE_URL must be set to your public HTTPS website URL in production.');
}
const siteRoot = path.resolve(__dirname, '..');
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
const smallJsonParser = express.json({ limit: '20kb' });
// Media uploads use their own larger, tightly capped JSON parser below.
app.use((req, res, next) => req.path === '/api/admin/media/upload' ? next() : smallJsonParser(req, res, next));
app.use(express.urlencoded({ extended: false }));

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 64) {
  throw new Error('SESSION_SECRET is missing or too short. Check server/.env.');
}

app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

app.use(session({
  store: new SQLiteSessionStore(),
  name: 'sth.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/'
  }
}));

// Upgrade existing authenticated sessions to the current 24-hour policy too.
// rolling:true refreshes the browser/app cookie and SQLite expiry on responses.
app.use((req, res, next) => {
  if (req.session?.staff) req.session.cookie.maxAge = SESSION_TTL_MS;
  next();
});

// Never expose backend source or environment files through static hosting.
app.use('/server', (req, res) => res.sendStatus(404));
app.use(express.static(siteRoot, { dotfiles: 'ignore' }));

app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ success: false, status: 'unavailable' });
  }
});

// Prices match the supplied public_html website. USD, before estimated fees.
const rooms = {
  standard: { name: 'Standard Suite', single: 50, double: 60 },
  executive: { name: 'Executive Suite', single: 60, double: 70 },
  deluxe: { name: 'Deluxe Suite', price: 100 },
  penthouse: { name: 'Penthouse Suite', price: 150 }
};
const addOns = {
  breakfast: { name: 'Breakfast for two', price: 32 },
  transfer: { name: 'Airport transfer', price: 45 },
  spa: { name: 'Spa credit', price: 75 },
  late: { name: 'Late check-out', price: 30 },
  celebration: { name: 'Celebration setup', price: 55 }
};
// In-memory transactions are suitable only for this local demo.
const transactions = new Map();

function configured() {
  const id = process.env.PAYNOW_INTEGRATION_ID || '';
  const key = process.env.PAYNOW_INTEGRATION_KEY || '';
  const email = process.env.PAYNOW_MERCHANT_EMAIL || '';
  return Boolean(id && key && email && !id.includes('PUT_') && !key.includes('PUT_') && !email.includes('YOUR_'));
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function calculate(body) {
  if (!validDate(body.checkin) || !validDate(body.checkout)) {
    throw new Error('Enter valid check-in and check-out dates.');
  }

  const nights = Math.round(
    (Date.parse(`${body.checkout}T00:00:00Z`) -
     Date.parse(`${body.checkin}T00:00:00Z`)) / 86400000
  );
  if (nights < 1 || nights > 60) {
    throw new Error('Stay must be between 1 and 60 nights.');
  }

  const room = db.prepare(
    'SELECT id, name, price_single, price_double, price, inventory_count FROM rooms WHERE id = ?'
  ).get(body.roomId);

  if (!room) throw new Error('Choose a valid room.');

  const guests = Math.max(1, Math.min(4, Number(body.guests) || 2));
  const roomRate = Number(guests <= 1 ? room.price_single : room.price_double);

  if (!Number.isFinite(roomRate) || roomRate < 0) {
    throw new Error('Room pricing is not configured correctly.');
  }

  const selected = Array.isArray(body.addons)
    ? [...new Set(body.addons)]
    : [];

  if (selected.some(id => typeof id !== 'string' || id.length > 64)) {
    throw new Error('Invalid add-on selection.');
  }

  const selectedAddons = selected.length
    ? db.prepare(
        `SELECT id, name, price FROM addons
         WHERE active = 1 AND id IN (${selected.map(() => '?').join(',')})`
      ).all(...selected)
    : [];

  if (selectedAddons.length !== selected.length) {
    throw new Error('Invalid add-on selection.');
  }

  const roomTotal = Math.round(roomRate * nights * 100) / 100;
  const extras = Math.round(
    selectedAddons.reduce((sum, addon) => sum + Number(addon.price), 0) * 100
  ) / 100;
  const subtotal = roomTotal + extras;
  const tax = Math.round(subtotal * 0.12 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;

  return {
    nights,
    room: { ...room, name: room.name },
    roomRate,
    roomTotal,
    selected,
    selectedAddons,
    extras,
    tax,
    total
  };
}
function validMediaUrl(value) {
  if (typeof value !== 'string') return false;
  if (!value) return true;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !/\s/.test(value);
  } catch { return false; }
}

function normalizeStatus(value) {
  return String(value || '').toLowerCase().replace(/\+/g, ' ').trim();
}
function isSuccessfulStatus(value) {
  return ['paid', 'awaiting delivery', 'delivered'].includes(normalizeStatus(value));
}


const loginAttempts = new Map();

function clearSessionCookie(res) {
  res.clearCookie('sth.sid', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}

function getActiveSessionStaff(req) {
  const sessionStaff = req.session?.staff;
  if (!sessionStaff?.id) return null;
  return db.prepare(
    'SELECT id, username, role FROM staff WHERE id = ? AND active = 1'
  ).get(sessionStaff.id) || null;
}

function rejectInvalidSession(req, res) {
  if (req.session) req.session.destroy(() => {});
  clearSessionCookie(res);
  res.set('Cache-Control', 'no-store');
  return res.status(401).json({ success: false, error: 'Authentication required.' });
}

function requireAuth(req, res, next) {
  const staff = getActiveSessionStaff(req);
  if (!staff) return rejectInvalidSession(req, res);
  req.session.staff = staff;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const staff = getActiveSessionStaff(req);
    if (!staff) return rejectInvalidSession(req, res);
    req.session.staff = staff;
    if (!roles.includes(staff.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions.' });
    }
    next();
  };
}

app.post('/api/auth/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let attempt = loginAttempts.get(ip);

  if (!attempt || now - attempt.startedAt > 15 * 60 * 1000) {
    attempt = { count: 0, startedAt: now };
    loginAttempts.set(ip, attempt);
  }

  if (attempt.count >= 10) {
    return res.status(429).json({
      success: false,
      error: 'Too many login attempts. Try again in 15 minutes.'
    });
  }

  const username = typeof req.body.username === 'string'
    ? req.body.username.trim()
    : '';
  const password = typeof req.body.password === 'string'
    ? req.body.password
    : '';

  if (!username || username.length > 32 ||
      !password || password.length > 128) {
    attempt.count++;
    return res.status(401).json({
      success: false,
      error: 'Invalid username or password.'
    });
  }

  try {
    const staff = db.prepare(
      'SELECT id, username, password_hash, role FROM staff WHERE username = ? AND active = 1'
    ).get(username);

    const valid = staff
      ? await verifyPassword(password, staff.password_hash)
      : false;

    if (!valid) {
      attempt.count++;
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password.'
      });
    }

    loginAttempts.delete(ip);

    req.session.regenerate(error => {
      if (error) {
        console.error('Session regeneration failed.');
        return res.status(500).json({
          success: false,
          error: 'Unable to start a session.'
        });
      }

      req.session.staff = {
        id: staff.id,
        username: staff.username,
        role: staff.role
      };

      req.session.save(saveError => {
        if (saveError) {
          console.error('Session save failed.');
          return res.status(500).json({
            success: false,
            error: 'Unable to save the session.'
          });
        }

        return res.json({
          success: true,
          staff: req.session.staff
        });
      });
    });
  } catch (error) {
    console.error('Login processing failed.');
    return res.status(500).json({
      success: false,
      error: 'Login could not be processed.'
    });
  }
});

app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const staff = getActiveSessionStaff(req);
  if (!staff) return rejectInvalidSession(req, res);
  req.session.staff = staff;
  res.json({ success: true, staff });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');

  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        success: false,
        error: 'Unable to log out.'
      });
    }

    clearSessionCookie(res);

    return res.json({ success: true, message: 'Logged out.' });
  });
});

app.get('/api/admin/rooms', requireRole('developer', 'administrator'), (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const rooms = db.prepare(`
      SELECT id, name, price_single, price_double, price, inventory_count, content_json, updated_at
      FROM rooms
      ORDER BY id
    `).all();

    res.json({ success: true, rooms });
  } catch (err) {
    console.error('Admin room list failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load rooms.' });
  }
});


app.put('/api/admin/rooms/:id',
  requireRole('developer', 'administrator'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    const id = req.params.id;
    const body = req.body || {};
    const allowed = ['name', 'price_single', 'price_double', 'inventory_count'];
    const keys = Object.keys(body);

    if (!id || id.length > 64 || keys.length === 0 ||
        keys.some(key => !allowed.includes(key))) {
      return res.status(400).json({
        success: false,
        error: 'Provide a valid room ID and only supported room fields.'
      });
    }

    const changes = {};

    if (Object.hasOwn(body, 'name')) {
      if (typeof body.name !== 'string' ||
          !body.name.trim() || body.name.trim().length > 100) {
        return res.status(400).json({
          success: false, error: 'Room name must be 1–100 characters.'
        });
      }
      changes.name = body.name.trim();
    }

    for (const field of ['price_single', 'price_double']) {
      if (Object.hasOwn(body, field)) {
        const value = Number(body[field]);
        if (body[field] === '' || !Number.isFinite(value) ||
            value < 0 || value > 10000 ||
            Math.round(value * 100) !== value * 100) {
          return res.status(400).json({
            success: false,
            error: field + ' must be a valid amount from 0 to 10000 with at most two decimals.'
          });
        }
        changes[field] = value;
      }
    }

    if (Object.hasOwn(body, 'inventory_count')) {
      const value = Number(body.inventory_count);
      if (body.inventory_count === '' || !Number.isInteger(value) || value < 0 || value > 10000) {
        return res.status(400).json({ success: false, error: 'Total physical rooms must be a whole number from 0 to 10000.' });
      }
      changes.inventory_count = value;
    }

    try {
      const saveRoom = db.transaction(() => {
        const existing = db.prepare(
          'SELECT id, name, price_single, price_double, price FROM rooms WHERE id = ?'
        ).get(id);

        if (!existing) return null;

        const merged = { ...existing, ...changes };
        const changed = Object.keys(changes).some(
          key => existing[key] !== changes[key]
        );

        if (!changed) return { room: existing, changed: false };

        db.prepare(`
          UPDATE rooms
          SET name = ?, price_single = ?, price_double = ?,
              price = ?, inventory_count = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          merged.name,
          merged.price_single,
          merged.price_double,
          merged.price_single,
          merged.inventory_count,
          id
        );

        db.prepare(`
          INSERT INTO audit_log
            (actor_staff_id, action, target_type, target_id, details_json)
          VALUES (?, 'room.updated', 'room', ?, ?)
        `).run(
          req.session.staff.id,
          id,
          JSON.stringify({ changes })
        );

        return {
          room: db.prepare(
            'SELECT id, name, price_single, price_double, price, inventory_count, content_json, updated_at FROM rooms WHERE id = ?'
          ).get(id),
          changed: true
        };
      });

      const result = saveRoom.immediate();
      if (!result) {
        return res.status(404).json({
          success: false, error: 'Room not found.'
        });
      }

      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('Room update failed:', error.message);
      return res.status(500).json({
        success: false, error: 'Unable to update room.'
      });
    }
  }
);

app.get('/api/admin/addons', requireRole('developer', 'administrator'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const addons = db.prepare('SELECT id, name, price, active, updated_at FROM addons ORDER BY id').all();
    res.json({ success: true, addons });
  } catch (error) {
    console.error('Admin add-on list failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load add-ons.' });
  }
});

app.put('/api/admin/addons/:id',
  requireRole('developer', 'administrator'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    const id = req.params.id;
    const body = req.body || {};
    const allowed = ['name', 'price', 'active'];
    const keys = Object.keys(body);

    if (!id || id.length > 64 || keys.length === 0 ||
        keys.some(key => !allowed.includes(key))) {
      return res.status(400).json({
        success: false,
        error: 'Provide a valid add-on ID and only supported fields.'
      });
    }

    const changes = {};

    if (Object.hasOwn(body, 'name')) {
      if (typeof body.name !== 'string' ||
          !body.name.trim() || body.name.trim().length > 100) {
        return res.status(400).json({
          success: false, error: 'Add-on name must be 1–100 characters.'
        });
      }
      changes.name = body.name.trim();
    }

    if (Object.hasOwn(body, 'price')) {
      const value = Number(body.price);
      if (body.price === '' || !Number.isFinite(value) ||
          value < 0 || value > 10000 ||
          Math.round(value * 100) !== value * 100) {
        return res.status(400).json({
          success: false,
          error: 'Add-on price must be from 0 to 10000 with at most two decimals.'
        });
      }
      changes.price = value;
    }

    if (Object.hasOwn(body, 'active')) {
      if (body.active !== true && body.active !== false &&
          body.active !== 0 && body.active !== 1) {
        return res.status(400).json({
          success: false, error: 'active must be true or false.'
        });
      }
      changes.active = body.active === true || body.active === 1 ? 1 : 0;
    }

    try {
      const saveAddon = db.transaction(() => {
        const existing = db.prepare(
          'SELECT id, name, price, active FROM addons WHERE id = ?'
        ).get(id);

        if (!existing) return null;

        const merged = { ...existing, ...changes };
        const changed = Object.keys(changes).some(
          key => existing[key] !== changes[key]
        );

        if (!changed) return { addon: existing, changed: false };

        db.prepare(`
          UPDATE addons
          SET name = ?, price = ?, active = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(merged.name, merged.price, merged.active, id);

        db.prepare(`
          INSERT INTO audit_log
            (actor_staff_id, action, target_type, target_id, details_json)
          VALUES (?, 'addon.updated', 'addon', ?, ?)
        `).run(
          req.session.staff.id,
          id,
          JSON.stringify({ changes })
        );

        return {
          addon: db.prepare(
            'SELECT id, name, price, active, updated_at FROM addons WHERE id = ?'
          ).get(id),
          changed: true
        };
      });

      const result = saveAddon.immediate();
      if (!result) {
        return res.status(404).json({
          success: false, error: 'Add-on not found.'
        });
      }

      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('Add-on update failed:', error.message);
      return res.status(500).json({
        success: false, error: 'Unable to update add-on.'
      });
    }
  }
);

app.get('/api/admin/overview', requireRole('developer', 'administrator', 'reception', 'read_only'), (req, res) => {
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      overview: {
        rooms: count('rooms'),
        addons: count('addons'),
        bookings: count('bookings'),
        reviews: count('reviews'),
        staff: count('staff')
      }
    });
  } catch (err) {
    console.error('Admin overview failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load admin overview.' });
  }
});

// ---- Staff and content-management API (admin workspace) ----
const mediaDirectory = path.join(siteRoot, 'assets', 'uploads', 'media');
const mediaPublicPrefix = '/assets/uploads/media/';
const MEDIA_LIMIT_BYTES = 15 * 1024 * 1024;
const MEDIA_TYPES = {
  'image/jpeg': { ext: '.jpg', kind: 'image' },
  'image/png': { ext: '.png', kind: 'image' },
  'image/webp': { ext: '.webp', kind: 'image' },
  'image/gif': { ext: '.gif', kind: 'image' },
  'image/avif': { ext: '.avif', kind: 'image' },
  'video/mp4': { ext: '.mp4', kind: 'video' },
  'video/webm': { ext: '.webm', kind: 'video' },
  'video/quicktime': { ext: '.mov', kind: 'video' }
};
function safeMediaFileInfo(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(path.join(mediaDirectory, file));
  if (!stat.isFile() || stat.size > MEDIA_LIMIT_BYTES) return null;
  const byExt = Object.values(MEDIA_TYPES).find(t => t.ext === ext);
  if (!byExt) return null;
  return { name: file, url: mediaPublicPrefix + encodeURIComponent(file), media_type: byExt.kind, size: stat.size, updated_at: stat.mtime.toISOString() };
}
app.get('/api/admin/media', requireRole('developer', 'administrator', 'read_only'), (req, res) => {
  try {
    fs.mkdirSync(mediaDirectory, { recursive: true });
    const files = fs.readdirSync(mediaDirectory).map(file => {
      try { return safeMediaFileInfo(file); } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, media: files, maxBytes: MEDIA_LIMIT_BYTES });
  } catch (error) {
    console.error('Media library listing failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load the media library.' });
  }
});
function listPublicMediaSlots() {
  const pages = fs.readdirSync(siteRoot).filter(name => /^[a-z0-9_-]+\.html$/i.test(name) && !['staff.html', 'stalff.html', 'stlaff.html', 'payment-return.html'].includes(name));
  const result = [];
  for (const page of pages) {
    const file = path.join(siteRoot, page);
    let html = '';
    try { html = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!html.includes('cms-public.js')) continue;
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || page.replace(/\.html$/i, '')).replace(/<[^>]+>/g, '').trim();
    const tags = html.match(/<(?:img|video)\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2] || tag.match(/\bposter\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
      const key = tag.match(/\bdata-media-slot\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
      if (!key) continue;
      const alt = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
      result.push({ key, page, pageTitle: title, label: alt || path.basename(src) || key.split('::').pop(), source: src, element: /^<video/i.test(tag) ? 'video' : 'image' });
    }
  }
  return result;
}
app.get('/api/admin/media/slots', requireRole('developer', 'administrator', 'read_only'), (req, res) => {
  try {
    const slots = listPublicMediaSlots();
    const overrides = db.prepare("SELECT id, title, media_url, media_type, published FROM content_items WHERE lower(section)='media'").all();
    const byKey = new Map(overrides.map(item => [item.title, item]));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, pages: [...new Map(slots.map(s => [s.page, { page: s.page, title: s.pageTitle }])).values()], slots: slots.map(slot => ({ ...slot, override: byKey.get(slot.key) || null })) });
  } catch (error) {
    console.error('Media slot listing failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load website media locations.' });
  }
});
function listPublicMediaGalleries() {
  const pages = fs.readdirSync(siteRoot).filter(name => /^[a-z0-9_-]+\.html$/i.test(name) && !['staff.html', 'stalff.html', 'stlaff.html', 'payment-return.html'].includes(name));
  const result = [];
  for (const page of pages) {
    let html = ''; try { html = fs.readFileSync(path.join(siteRoot, page), 'utf8'); } catch { continue; }
    if (!html.includes('cms-public.js')) continue;
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || page).replace(/<[^>]+>/g, '').trim();
    const tags = html.match(/<([a-z0-9]+)\b[^>]*\bdata-media-gallery\s*=\s*(["'])(.*?)\2[^>]*>/gi) || [];
    for (const tag of tags) {
      const key = tag.match(/\bdata-media-gallery\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!key || !/^[a-z0-9_.:-]{1,180}$/i.test(key)) continue;
      const label = tag.match(/\bdata-media-gallery-label\s*=\s*(["'])(.*?)\1/i)?.[2] || key;
      const cls = tag.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
      result.push({ key, page, pageTitle: title, label, className: cls });
    }
  }
  return result;
}
app.get('/api/admin/media/galleries', requireRole('developer', 'administrator', 'read_only'), (req, res) => {
  try {
    const galleries = listPublicMediaGalleries();
    const items = db.prepare("SELECT id,title,body,media_url,media_type,published FROM content_items WHERE lower(section)='media_gallery' ORDER BY id ASC").all();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, galleries: galleries.map(g => ({ ...g, items: items.filter(i => i.title === g.key) })) });
  } catch (error) { res.status(500).json({ success:false, error:'Unable to load media galleries.' }); }
});
app.post('/api/admin/media/gallery-item', requireRole('developer', 'administrator'), (req, res) => {
  try {
    const key = textField(req.body?.key, 180, 'Gallery', { required:true });
    if (!listPublicMediaGalleries().some(g => g.key === key)) return res.status(404).json({ success:false, error:'That gallery no longer exists. Refresh the page.' });
    const mediaUrl = textField(req.body?.media_url, 1000, 'Media file', { required:true });
    if (!validMediaUrl(mediaUrl)) throw new Error('Choose a valid uploaded media file or HTTPS URL.');
    const mediaType = req.body?.media_type;
    if (!['image','video'].includes(mediaType)) throw new Error('Choose an image or video.');
    const caption = textField(req.body?.body || '', 500, 'Caption');
    const published = boolField(req.body?.published ?? false, 'published');
    const tx = db.transaction(() => {
      const result = db.prepare("INSERT INTO content_items (section,title,body,media_url,media_type,published,updated_at) VALUES ('media_gallery',?,?,?,?,?,CURRENT_TIMESTAMP)").run(key, caption, mediaUrl, mediaType, published);
      writeAudit(req.session.staff.id, 'media.gallery_item.created', 'media_gallery', result.lastInsertRowid, { gallery:key, published });
      return result.lastInsertRowid;
    });
    const id = tx.immediate();
    res.status(201).json({ success:true, id, key, published:Boolean(published) });
  } catch (error) { res.status(400).json({ success:false, error:error.message || 'Unable to save gallery item.' }); }
});
app.post('/api/admin/media/slot', requireRole('developer', 'administrator'), (req, res) => {
  try {
    const key = textField(req.body?.key, 300, 'Media location', { required: true });
    if (!listPublicMediaSlots().some(slot => slot.key === key)) return res.status(404).json({ success: false, error: 'That media location no longer exists on the website. Refresh the list.' });
    const mediaUrl = textField(req.body?.media_url, 1000, 'Media file', { required: true });
    if (!validMediaUrl(mediaUrl)) throw new Error('Choose a valid uploaded media file or HTTPS media URL.');
    const mediaType = req.body?.media_type;
    if (!['image', 'video'].includes(mediaType)) throw new Error('Choose an image or video.');
    const published = boolField(req.body?.published ?? true, 'published');
    const tx = db.transaction(() => {
      const old = db.prepare("SELECT id FROM content_items WHERE lower(section)='media' AND title=? ORDER BY id DESC LIMIT 1").get(key);
      if (old) {
        db.prepare("UPDATE content_items SET body='', media_url=?, media_type=?, published=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(mediaUrl, mediaType, published, old.id);
        writeAudit(req.session.staff.id, 'media.slot.updated', 'media_slot', key, { media_type: mediaType, published });
        return old.id;
      }
      const created = db.prepare("INSERT INTO content_items (section,title,body,media_url,media_type,published,updated_at) VALUES ('media',?,'',?,?,?,CURRENT_TIMESTAMP)").run(key, mediaUrl, mediaType, published);
      writeAudit(req.session.staff.id, 'media.slot.created', 'media_slot', key, { media_type: mediaType, published });
      return created.lastInsertRowid;
    });
    const id = tx.immediate();
    res.status(200).json({ success: true, id, key, media_url: mediaUrl, media_type: mediaType, published: Boolean(published) });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Unable to save this media location.' });
  }
});
app.delete('/api/admin/media/:filename', requireRole('developer', 'administrator'), (req, res) => {
  try {
    const filename = path.basename(decodeURIComponent(req.params.filename));
    if (!filename || filename !== req.params.filename) return res.status(400).json({ success: false, error: 'Invalid media filename.' });
    const filePath = path.join(mediaDirectory, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ success: false, error: 'Uploaded media file not found.' });
    const references = db.prepare('SELECT COUNT(*) AS count FROM content_items WHERE media_url=? OR media_url=?').get(mediaPublicPrefix + encodeURIComponent(filename), mediaPublicPrefix + filename).count;
    const publicReferences = fs.readdirSync(siteRoot).filter(name => name.endsWith('.html')).some(name => {
      try { const html = fs.readFileSync(path.join(siteRoot, name), 'utf8'); return html.includes(filename) || html.includes(encodeURIComponent(filename)); } catch { return false; }
    });
    if (references || publicReferences) return res.status(409).json({ success: false, error: 'This file is currently used by website content. Replace or remove those references before deleting it.' });
    fs.unlinkSync(filePath);
    writeAudit(req.session.staff.id, 'media.deleted', 'media', filename);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Unable to delete this media file.' });
  }
});

app.post('/api/admin/media/upload', express.json({ limit: '22mb' }), requireRole('developer', 'administrator'), (req, res) => {
  try {
    const dataUrl = req.body?.data;
    const originalName = typeof req.body?.originalName === 'string' ? req.body.originalName.slice(0, 180) : 'uploaded-media';
    if (typeof dataUrl !== 'string' || dataUrl.length > 21 * 1024 * 1024) throw new Error('Choose a file smaller than 15 MB.');
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif|avif)|video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('Choose a JPG, PNG, WebP, GIF, AVIF, MP4, WebM or MOV file.');
    const mime = match[1];
    const type = MEDIA_TYPES[mime];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MEDIA_LIMIT_BYTES) throw new Error('The file must be smaller than 15 MB.');
    // Check common file signatures instead of trusting the browser's declared MIME type.
    const sig = buffer.subarray(0, 16);
    const signatures = {
      'image/jpeg': () => sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff,
      'image/png': () => sig.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
      'image/webp': () => sig.toString('ascii',0,4) === 'RIFF' && sig.toString('ascii',8,12) === 'WEBP',
      'image/gif': () => ['GIF87a','GIF89a'].includes(sig.toString('ascii',0,6)),
      'image/avif': () => sig.toString('ascii',4,8) === 'ftyp' && /avif|avis/.test(buffer.toString('ascii',8,24)),
      'video/mp4': () => sig.toString('ascii',4,8) === 'ftyp',
      'video/quicktime': () => sig.toString('ascii',4,8) === 'ftyp',
      'video/webm': () => sig.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
    };
    if (!signatures[mime] || !signatures[mime]()) throw new Error('The file content does not match its media type. Please choose the original image or video file.');
    fs.mkdirSync(mediaDirectory, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${type.ext}`;
    fs.writeFileSync(path.join(mediaDirectory, filename), buffer, { flag: 'wx', mode: 0o644 });
    const media = { name: filename, url: mediaPublicPrefix + encodeURIComponent(filename), media_type: type.kind, size: buffer.length, originalName };
    writeAudit(req.session.staff.id, 'media.uploaded', 'media', filename, { media_type: type.kind, bytes: buffer.length });
    res.status(201).json({ success: true, media });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Unable to upload this file.' });
  }
});
function writeAudit(actorId, action, targetType, targetId, details = {}) {
  db.prepare(`INSERT INTO audit_log
    (actor_staff_id, action, target_type, target_id, details_json)
    VALUES (?, ?, ?, ?, ?)`)
    .run(actorId, action, targetType, String(targetId ?? ''), JSON.stringify(details));
}

// Install the selectable Testing & Data Reset Manager on the current enquiry-aware backend.
installResetManager(app, db, requireAuth, writeAudit);

// Evolution API inbound WhatsApp webhook; writes into the existing enquiries and alarm system.
installWhatsAppWebhook(app, db, sendEnquiryNotifications, writeAudit);
installWhatsAppReply(app, db, requireRole, writeAudit);
installEnquiryCleanup(app, db, requireAuth, writeAudit);
function textField(value, max, field, { required = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const v = value.trim();
  if ((required && !v) || v.length > max) throw new Error(`${field} is required and must be no longer than ${max} characters.`);
  return v;
}
function boolField(value, field) {
  if (![true, false, 0, 1].includes(value)) throw new Error(`${field} must be true or false.`);
  return value === true || value === 1 ? 1 : 0;
}

// Staff account creation is restricted to trusted management. Only the developer
// may create another developer or an administrator account.
app.get('/api/admin/staff', requireRole('developer', 'administrator'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const staff = db.prepare(`SELECT id, username, role, active, created_at FROM staff ORDER BY id`).all();
  res.json({ success: true, staff });
});

app.post('/api/admin/staff', requireRole('developer', 'administrator'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const username = textField(req.body?.username, 32, 'Username', { required: true });
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots, underscores or hyphens.');
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Password must be 12–128 characters.');
    const role = req.body?.role;
    if (!['administrator', 'reception', 'read_only', 'developer'].includes(role)) throw new Error('Choose a valid staff role.');
    if (req.session.staff.role !== 'developer' && ['administrator', 'developer'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Only the developer can create administrator or developer accounts.' });
    }
    const passwordHash = await hashPassword(password);
    const create = db.transaction(() => {
      const result = db.prepare('INSERT INTO staff (username, password_hash, role, active) VALUES (?, ?, ?, 1)').run(username, passwordHash, role);
      writeAudit(req.session.staff.id, 'staff.created', 'staff', result.lastInsertRowid, { username, role });
      return result.lastInsertRowid;
    });
    const id = create.immediate();
    res.status(201).json({ success: true, staff: db.prepare('SELECT id, username, role, active, created_at FROM staff WHERE id = ?').get(id) });
  } catch (error) {
    const duplicate = String(error.message).includes('UNIQUE constraint failed');
    res.status(duplicate ? 409 : 400).json({ success: false, error: duplicate ? 'That username is already in use.' : error.message });
  }
});

app.patch('/api/admin/staff/:id', requireRole('developer', 'administrator'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Invalid staff ID.' });
  const body = req.body || {};
  if (Object.keys(body).some(k => !['active', 'role'].includes(k)) || !Object.keys(body).length) return res.status(400).json({ success: false, error: 'Only active and role can be changed here.' });
  try {
    const target = db.prepare('SELECT id, username, role, active FROM staff WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ success: false, error: 'Staff account not found.' });
    if (req.session.staff.role !== 'developer' && target.role === 'developer') {
      return res.status(403).json({ success: false, error: 'Only the developer can manage the developer account.' });
    }
    if (target.id === req.session.staff.id && Object.hasOwn(body, 'active') && !body.active) return res.status(400).json({ success: false, error: 'You cannot deactivate your own account.' });
    const changes = {};
    if (Object.hasOwn(body, 'active')) changes.active = boolField(body.active, 'active');
    if (Object.hasOwn(body, 'role')) {
      if (!['developer', 'administrator', 'reception', 'read_only'].includes(body.role)) throw new Error('Invalid role.');
      if (req.session.staff.role !== 'developer' && (target.role === 'developer' || ['developer', 'administrator'].includes(body.role))) return res.status(403).json({ success: false, error: 'Only the developer can change developer/administrator roles.' });
      if (target.role === 'developer' && body.role !== 'developer') return res.status(403).json({ success: false, error: 'The developer role can only be changed by a separate handover process.' });
      changes.role = body.role;
    }
    const merged = { ...target, ...changes };
    const tx = db.transaction(() => {
      db.prepare('UPDATE staff SET role = ?, active = ? WHERE id = ?').run(merged.role, merged.active, id);
      writeAudit(req.session.staff.id, 'staff.updated', 'staff', id, { changes });
    });
    tx.immediate();
    res.json({ success: true, staff: db.prepare('SELECT id, username, role, active, created_at FROM staff WHERE id = ?').get(id) });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});

app.get('/api/admin/bookings', requireRole('developer', 'administrator', 'reception', 'read_only'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const bookings = db.prepare(`SELECT id, reference, checkin, checkout, guests, room_id, room_name, amount, booking_status, payment_status, selected_addons_json, created_at FROM bookings ORDER BY created_at DESC LIMIT 500`).all();
  res.json({ success: true, bookings: bookings.map(b => ({ ...b, selected_addons: (() => { try { return JSON.parse(b.selected_addons_json); } catch { return []; } })() })) });
});

app.patch('/api/admin/bookings/:id', requireRole('developer', 'administrator', 'reception'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = Number(req.params.id);
  const status = req.body?.booking_status;
  if (!Number.isSafeInteger(id) || id < 1 || !['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid booking ID or booking status.' });
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!booking) return res.status(404).json({ success: false, error: 'Booking not found.' });
  if (status === 'confirmed' && booking.payment_status !== 'paid') return res.status(409).json({ success: false, error: 'A booking cannot be confirmed until payment is marked paid by the payment verification flow.' });
  if (req.session.staff.role === 'reception' && status === 'confirmed' && booking.payment_status !== 'paid') return res.status(403).json({ success: false, error: 'Reception cannot override payment status.' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE bookings SET booking_status = ? WHERE id = ?').run(status, id);
    writeAudit(req.session.staff.id, 'booking.status_updated', 'booking', booking.reference, { from: booking.booking_status, to: status });
  });
  tx.immediate();
  res.json({ success: true, booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) });
});

app.get('/api/admin/reviews', requireRole('developer', 'administrator', 'read_only'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, reviews: db.prepare('SELECT id, guest_name, rating, explanation, published, updated_at FROM reviews ORDER BY id DESC').all() });
});
app.post('/api/admin/reviews', requireRole('developer', 'administrator'), (req, res) => {
  try {
    const name = textField(req.body?.guest_name, 100, 'Guest name', { required: true });
    const explanation = textField(req.body?.explanation, 2000, 'Review text', { required: true });
    const rating = Number(req.body?.rating);
    const published = boolField(req.body?.published ?? false, 'published');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be from 1 to 5.');
    const tx = db.transaction(() => {
      const result = db.prepare('INSERT INTO reviews (guest_name, rating, explanation, published, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(name, rating, explanation, published);
      writeAudit(req.session.staff.id, 'review.created', 'review', result.lastInsertRowid, { rating, published });
      return result.lastInsertRowid;
    });
    const id = tx.immediate();
    res.status(201).json({ success: true, review: db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.put('/api/admin/reviews/:id', requireRole('developer', 'administrator'), (req, res) => {
  const id = Number(req.params.id); const body = req.body || {};
  try {
    const old = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!old) return res.status(404).json({ success: false, error: 'Review not found.' });
    const name = Object.hasOwn(body, 'guest_name') ? textField(body.guest_name, 100, 'Guest name', { required: true }) : old.guest_name;
    const explanation = Object.hasOwn(body, 'explanation') ? textField(body.explanation, 2000, 'Review text', { required: true }) : old.explanation;
    const rating = Object.hasOwn(body, 'rating') ? Number(body.rating) : old.rating;
    const published = Object.hasOwn(body, 'published') ? boolField(body.published, 'published') : old.published;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('Rating must be from 1 to 5.');
    const tx = db.transaction(() => { db.prepare('UPDATE reviews SET guest_name=?, rating=?, explanation=?, published=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, rating, explanation, published, id); writeAudit(req.session.staff.id, 'review.updated', 'review', id, { published }); }); tx.immediate();
    res.json({ success: true, review: db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.delete('/api/admin/reviews/:id', requireRole('developer', 'administrator'), (req, res) => {
  const id = Number(req.params.id); const tx = db.transaction(() => { const old = db.prepare('SELECT id FROM reviews WHERE id=?').get(id); if (!old) return false; db.prepare('DELETE FROM reviews WHERE id=?').run(id); writeAudit(req.session.staff.id, 'review.deleted', 'review', id); return true; });
  if (!tx.immediate()) return res.status(404).json({ success: false, error: 'Review not found.' }); res.json({ success: true });
});

app.get('/api/admin/content', requireRole('developer', 'administrator', 'read_only'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, content: db.prepare('SELECT id, section, title, body, media_url, media_type, published, updated_at FROM content_items ORDER BY id DESC').all() });
});
app.post('/api/admin/content', requireRole('developer', 'administrator'), (req, res) => {
  try {
    const section = textField(req.body?.section, 80, 'Section', { required: true });
    const title = textField(req.body?.title ?? '', 160, 'Title');
    const body = textField(req.body?.body ?? '', 10000, 'Body');
    const media_url = textField(req.body?.media_url ?? '', 1000, 'Media URL');
    const media_type = req.body?.media_type ?? (media_url ? 'image' : 'none');
    if (!['none', 'image', 'video'].includes(media_type)) throw new Error('Media type must be none, image or video.');
    if (!validMediaUrl(media_url)) throw new Error('Media URL must be a site-relative path or HTTPS URL.');
    const published = boolField(req.body?.published ?? false, 'published');
    const tx = db.transaction(() => { const result = db.prepare('INSERT INTO content_items (section,title,body,media_url,media_type,published,updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(section,title,body,media_url,media_type,published); writeAudit(req.session.staff.id, 'content.created', 'content', result.lastInsertRowid, { section, published }); return result.lastInsertRowid; });
    const id = tx.immediate(); res.status(201).json({ success: true, content: db.prepare('SELECT * FROM content_items WHERE id=?').get(id) });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
});
app.put('/api/admin/content/:id', requireRole('developer', 'administrator'), (req, res) => {
  const id = Number(req.params.id); const body = req.body || {};
  try {
    const old = db.prepare('SELECT * FROM content_items WHERE id=?').get(id); if (!old) return res.status(404).json({ success: false, error: 'Content item not found.' });
    const section = Object.hasOwn(body,'section') ? textField(body.section,80,'Section',{required:true}) : old.section;
    const title = Object.hasOwn(body,'title') ? textField(body.title,160,'Title') : old.title;
    const contentBody = Object.hasOwn(body,'body') ? textField(body.body,10000,'Body') : old.body;
    const media_url = Object.hasOwn(body,'media_url') ? textField(body.media_url,1000,'Media URL') : old.media_url;
    const media_type = Object.hasOwn(body,'media_type') ? body.media_type : old.media_type;
    if (!['none','image','video'].includes(media_type)) throw new Error('Invalid media type.');
    if (!validMediaUrl(media_url)) throw new Error('Media URL must be a site-relative path or HTTPS URL.');
    const published = Object.hasOwn(body,'published') ? boolField(body.published,'published') : old.published;
    const tx = db.transaction(() => { db.prepare('UPDATE content_items SET section=?,title=?,body=?,media_url=?,media_type=?,published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(section,title,contentBody,media_url,media_type,published,id); writeAudit(req.session.staff.id,'content.updated','content',id,{section,published}); }); tx.immediate();
    res.json({ success:true, content:db.prepare('SELECT * FROM content_items WHERE id=?').get(id) });
  } catch (error) { res.status(400).json({ success:false,error:error.message }); }
});
app.delete('/api/admin/content/:id', requireRole('developer', 'administrator'), (req,res) => { const id=Number(req.params.id); const tx=db.transaction(()=>{const old=db.prepare('SELECT id FROM content_items WHERE id=?').get(id);if(!old)return false;db.prepare('DELETE FROM content_items WHERE id=?').run(id);writeAudit(req.session.staff.id,'content.deleted','content',id);return true;}); if(!tx.immediate())return res.status(404).json({success:false,error:'Content item not found.'});res.json({success:true}); });

app.get('/api/admin/settings', requireRole('developer', 'administrator', 'read_only'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, settings: db.prepare('SELECT key, value, updated_at FROM site_settings ORDER BY key').all() });
});
app.put('/api/admin/settings/:key', requireRole('developer', 'administrator'), (req, res) => {
  try {
    const key = textField(req.params.key, 100, 'Setting key', { required: true });
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error('Setting key contains unsupported characters.');
    const value = textField(req.body?.value ?? '', 5000, 'Setting value');
    const tx = db.transaction(() => { db.prepare(`INSERT INTO site_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(key,value); writeAudit(req.session.staff.id,'setting.updated','setting',key,{ valueLength:value.length }); }); tx.immediate();
    res.json({ success:true, setting:db.prepare('SELECT key,value,updated_at FROM site_settings WHERE key=?').get(key) });
  } catch (error) { res.status(400).json({success:false,error:error.message}); }
});
app.get('/api/admin/audit-log', requireRole('developer', 'administrator'), (req, res) => {
  res.set('Cache-Control','no-store');
  const entries = db.prepare(`SELECT a.id,a.actor_staff_id,s.username AS actor_username,a.action,a.target_type,a.target_id,a.details_json,a.created_at FROM audit_log a LEFT JOIN staff s ON s.id=a.actor_staff_id ORDER BY a.id DESC LIMIT 250`).all();
  res.json({success:true, entries:entries.map(a=>({...a,details:(()=>{try{return JSON.parse(a.details_json)}catch{return {}}})()}))});
});

// Public, read-only inventory endpoints keep public rate displays aligned with the database.
app.get('/api/public/rooms', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const rooms = db.prepare(`SELECT id, name, price_single, price_double, price, inventory_count
                             FROM rooms ORDER BY CASE id WHEN 'standard' THEN 1 WHEN 'executive' THEN 2 WHEN 'deluxe' THEN 3 WHEN 'penthouse' THEN 4 ELSE 5 END, id`).all();
    res.json({ success: true, rooms });
  } catch (error) {
    console.error('Public room list failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load room rates.' });
  }
});


// Capacity is counted per night, so bookings that overlap only part of a stay
// do not incorrectly block the whole date range. The database stores room types,
// not individual room numbers, so rooms of a category are treated as fungible.
function roomAvailability(roomId, checkin, checkout, now = new Date().toISOString(), excludeReference = '') {
  const room = db.prepare('SELECT inventory_count FROM rooms WHERE id = ?').get(roomId);
  if (!room) return { inventory: 0, available: 0, maxOccupied: 0, validRoom: false };
  const bookings = db.prepare(`
    SELECT reference, checkin, checkout FROM bookings
    WHERE room_id = ? AND booking_status = 'confirmed'
      AND reference <> ? AND checkin < ? AND checkout > ?
  `).all(roomId, excludeReference, checkout, checkin);
  const holds = db.prepare(`
    SELECT reference, checkin, checkout FROM booking_holds
    WHERE room_id = ? AND status = 'active' AND expires_at > ?
      AND reference <> ? AND checkin < ? AND checkout > ?
  `).all(roomId, now, excludeReference, checkout, checkin);
  let maxOccupied = 0;
  for (let night = Date.parse(checkin + 'T00:00:00Z'); night < Date.parse(checkout + 'T00:00:00Z'); night += 86400000) {
    const day = new Date(night).toISOString().slice(0, 10);
    let occupied = 0;
    for (const booking of bookings) if (booking.checkin <= day && booking.checkout > day) occupied++;
    for (const hold of holds) if (hold.checkin <= day && hold.checkout > day) occupied++;
    if (occupied > maxOccupied) maxOccupied = occupied;
  }
  const inventory = Number(room.inventory_count) || 0;
  return { inventory, available: Math.max(0, inventory - maxOccupied), maxOccupied, validRoom: true };
}

app.get('/api/public/availability', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const checkin = typeof req.query.checkin === 'string' ? req.query.checkin : '';
  const checkout = typeof req.query.checkout === 'string' ? req.query.checkout : '';
  if (!validDate(checkin) || !validDate(checkout) || checkout <= checkin) {
    return res.status(400).json({ success: false, error: 'Choose valid check-in and check-out dates to check availability.' });
  }
  const nights = (Date.parse(checkout + 'T00:00:00Z') - Date.parse(checkin + 'T00:00:00Z')) / 86400000;
  if (nights < 1 || nights > 60) return res.status(400).json({ success: false, error: 'Stay must be between 1 and 60 nights.' });
  try {
    const rooms = db.prepare(`SELECT id, name, inventory_count FROM rooms ORDER BY CASE id WHEN 'standard' THEN 1 WHEN 'executive' THEN 2 WHEN 'deluxe' THEN 3 WHEN 'penthouse' THEN 4 ELSE 5 END, id`).all();
    const now = new Date().toISOString();
    return res.json({ success: true, checkin, checkout, rooms: rooms.map(room => ({ id: room.id, name: room.name, ...roomAvailability(room.id, checkin, checkout, now) })) });
  } catch (error) {
    console.error('Public availability check failed:', error.message);
    return res.status(500).json({ success: false, error: 'Unable to check room availability right now.' });
  }
});

app.get('/api/public/addons', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const addons = db.prepare('SELECT id, name, price FROM addons WHERE active = 1 ORDER BY id').all();
    res.json({ success: true, addons });
  } catch (error) {
    console.error('Public add-on list failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load add-ons.' });
  }
});

// Public, read-only CMS endpoints. Only explicitly published records are exposed.
app.get('/api/public/content', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const section = typeof req.query.section === 'string' ? req.query.section.trim().toLowerCase() : '';
  if (section && !/^[a-z0-9_-]{1,80}$/.test(section)) {
    return res.status(400).json({ success: false, error: 'Invalid content section.' });
  }
  try {
    const items = section
      ? db.prepare(`SELECT id, section, title, body, media_url, media_type, updated_at
                    FROM content_items WHERE published = 1 AND lower(section) = ?
                    ORDER BY updated_at DESC, id DESC LIMIT 100`).all(section)
      : db.prepare(`SELECT id, section, title, body, media_url, media_type, updated_at
                    FROM content_items WHERE published = 1
                    ORDER BY updated_at DESC, id DESC LIMIT 100`).all();
    res.json({ success: true, content: items });
  } catch (error) {
    console.error('Public content query failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load published content.' });
  }
});

app.get('/api/public/reviews', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const reviews = db.prepare(`SELECT id, guest_name, rating, explanation, updated_at
                                FROM reviews WHERE published = 1
                                ORDER BY updated_at DESC, id DESC LIMIT 12`).all();
    res.json({ success: true, reviews });
  } catch (error) {
    console.error('Public reviews query failed:', error.message);
    res.status(500).json({ success: false, error: 'Unable to load published reviews.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, configured: configured(), mode: 'local test' }));

app.post('/api/paynow/initiate', async (req, res) => {
  if (!configured()) {
    return res.status(503).json({
      success: false,
      error: 'Paynow test credentials are not fully configured.'
    });
  }

  let booking;
  try {
    booking = calculate(req.body || {});
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  const checkin = req.body.checkin;
  const checkout = req.body.checkout;
  const guests = Math.max(1, Math.min(4, Number(req.body.guests) || 2));
  const reference =
    `STH-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  let holdCreated = false;

  try {
    // Reserve the dates atomically before contacting Paynow.
    const createHold = db.transaction(() => {
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE booking_holds
        SET status = 'released'
        WHERE status = 'active' AND expires_at <= ?
      `).run(now);

      const capacity = roomAvailability(req.body.roomId, checkin, checkout, now);
      if (!capacity.validRoom || capacity.available < 1) return false;

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO booking_holds
          (reference, room_id, checkin, checkout, status, expires_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(reference, req.body.roomId, checkin, checkout, expiresAt);

      return true;
    });

    holdCreated = createHold.immediate();

    if (!holdCreated) {
      return res.status(409).json({
        success: false,
        error: 'This room is unavailable for the selected dates. Please choose different dates or another room.'
      });
    }

    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    paynow.resultUrl = `${PUBLIC_BASE_URL}/api/paynow/result`;
    paynow.returnUrl = `${PUBLIC_BASE_URL}/payment-return.html?reference=${encodeURIComponent(reference)}`;

    const payment = paynow.createPayment(
      reference,
      process.env.PAYNOW_MERCHANT_EMAIL
    );

    payment.add(
      `${booking.room.name} — ${booking.nights} night${booking.nights === 1 ? '' : 's'}`,
      booking.roomTotal
    );

    for (const addon of booking.selectedAddons) {
      payment.add(addon.name, addon.price);
    }

    if (booking.tax > 0) {
      payment.add('Estimated taxes and fees (12%)', booking.tax);
    }

    const response = await paynow.send(payment);

    if (!response || !response.success || !response.pollUrl || !response.redirectUrl) {
      db.prepare(`
        UPDATE booking_holds SET status = 'released'
        WHERE reference = ? AND status = 'active'
      `).run(reference);

      console.error('Paynow initiation response:', {
        success: response?.success,
        error: response?.error,
        message: response?.message
      });

      return res.status(502).json({
        success: false,
        error: 'Paynow could not start checkout. Please try again.'
      });
    }

    db.prepare(`
      INSERT INTO payment_transactions
        (reference, booking_json, poll_url, amount, status, paynow_status)
      VALUES (?, ?, ?, ?, 'pending', 'pending')
    `).run(
      reference,
      JSON.stringify({
        checkin,
        checkout,
        guests,
        roomId: req.body.roomId,
        roomName: booking.room.name,
        nights: booking.nights,
        roomRate: booking.roomRate,
        roomTotal: booking.roomTotal,
        selectedAddons: booking.selected,
        extras: booking.extras,
        tax: booking.tax,
        total: booking.total
      }),
      response.pollUrl,
      booking.total
    );

    console.log(
      `Paynow test checkout started: ${reference}; amount USD ${booking.total.toFixed(2)}`
    );

    return res.json({
      success: true,
      reference,
      amount: booking.total,
      redirectUrl: response.redirectUrl
    });
  } catch (error) {
    if (holdCreated) {
      try {
        db.prepare(`
          UPDATE booking_holds SET status = 'released'
          WHERE reference = ? AND status = 'active'
        `).run(reference);
      } catch (releaseError) {
        console.error('Could not release checkout hold:', releaseError.message);
      }
    }

    console.error('Paynow initiation failed:', error.message);

    return res.status(502).json({
      success: false,
      error: 'Paynow request failed. Please try again.'
    });
  }
});

app.post('/api/paynow/result', (req, res) => {
  // Never trust an unverified callback to confirm payment. Local demo uses polling.
  res.status(200).send('Result received. Use the status poll endpoint for local testing.');
});

app.get('/api/paynow/status/:reference', async (req, res) => {
  const reference = req.params.reference;

  const tx = db.prepare(`
    SELECT poll_url AS pollUrl,
           amount,
           status,
           paynow_status AS paynowStatus,
           booking_json AS bookingJson
    FROM payment_transactions
    WHERE reference = ?
  `).get(reference);

  if (!tx) {
    return res.status(404).json({
      success: false,
      error: 'Payment reference not found.'
    });
  }

  try {
    const paynow = new Paynow(
      process.env.PAYNOW_INTEGRATION_ID,
      process.env.PAYNOW_INTEGRATION_KEY
    );

    const gatewayStatus = await paynow.pollTransaction(tx.pollUrl);
    const rawStatus = normalizeStatus(
      gatewayStatus && gatewayStatus.status
    );

    const paidFlag = gatewayStatus && (
      typeof gatewayStatus.paid === 'function'
        ? gatewayStatus.paid()
        : gatewayStatus.paid === true
    );

    // Only the current Paynow response can establish current payment success.
    const gatewayPaid = Boolean(paidFlag) || isSuccessfulStatus(rawStatus);
    const paymentReversed = ['disputed', 'refunded'].includes(rawStatus);
    const paid = gatewayPaid;

    const bookingData = JSON.parse(tx.bookingJson);

    let nextStatus = 'pending';
    let bookingCreated = false;
    let bookingExists = false;
    let bookingConflict = false;

    const saveResult = db.transaction(() => {
      const now = new Date().toISOString();

      // Expired holds must not block new reservations.
      db.prepare(`
        UPDATE booking_holds
        SET status = 'released'
        WHERE status = 'active'
          AND expires_at <= ?
      `).run(now);

      if (paid) {
        nextStatus = 'paid';

        db.prepare(`
          UPDATE payment_transactions
          SET status = 'paid',
              paynow_status = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE reference = ?
        `).run(rawStatus || tx.paynowStatus || 'paid', reference);

        const existing = db.prepare(`
          SELECT id
          FROM bookings
          WHERE reference = ?
        `).get(reference);

        if (existing) {
          bookingExists = true;

          db.prepare(`
            UPDATE booking_holds
            SET status = 'confirmed'
            WHERE reference = ?
          `).run(reference);

          return;
        }

        // Enforce category capacity, excluding this payment's own hold.
        const capacity = roomAvailability(bookingData.roomId, bookingData.checkin, bookingData.checkout, now, reference);

        if (!capacity.validRoom || capacity.available < 1) {
          bookingConflict = true;

          // Payment is paid, but the room needs manual resolution.
          db.prepare(`
            UPDATE booking_holds
            SET status = 'released'
            WHERE reference = ?
          `).run(reference);

          return;
        }

        db.prepare(`
          INSERT INTO bookings (
            reference,
            checkin,
            checkout,
            guests,
            room_id,
            room_name,
            amount,
            booking_status,
            payment_status,
            selected_addons_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'paid', ?)
        `).run(
          reference,
          bookingData.checkin,
          bookingData.checkout,
          bookingData.guests,
          bookingData.roomId,
          bookingData.roomName,
          tx.amount,
          JSON.stringify(bookingData.selectedAddons || [])
        );

        // Confirm the hold, or record a confirmed hold if this
        // payment predates the room-hold system.
        const hold = db.prepare(`
          SELECT reference
          FROM booking_holds
          WHERE reference = ?
        `).get(reference);

        if (hold) {
          db.prepare(`
            UPDATE booking_holds
            SET status = 'confirmed'
            WHERE reference = ?
          `).run(reference);
        } else {
          db.prepare(`
            INSERT INTO booking_holds (
              reference, room_id, checkin, checkout, status, expires_at
            )
            VALUES (?, ?, ?, ?, 'confirmed', ?)
          `).run(
            reference,
            bookingData.roomId,
            bookingData.checkin,
            bookingData.checkout,
            now
          );
        }

        bookingCreated = true;
        return;
      }

      if (paymentReversed) {
        // Keep the internal paid history, but record the current gateway
        // status separately and flag the transaction for manual review.
        nextStatus = tx.status === 'paid' ? 'paid' : 'failed';
      } else if (rawStatus.includes('cancel')) {
        nextStatus = 'cancelled';
      } else if (
        rawStatus.includes('fail') ||
        rawStatus.includes('declin')
      ) {
        nextStatus = 'failed';
      } else {
        nextStatus = tx.status === 'paid' ? 'paid' : 'pending';
      }

      db.prepare(`
        UPDATE payment_transactions
        SET status = ?,
            paynow_status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE reference = ?
      `).run(
        nextStatus,
        rawStatus || tx.paynowStatus || 'pending',
        reference
      );

      if (nextStatus === 'failed' || nextStatus === 'cancelled') {
        db.prepare(`
          UPDATE booking_holds
          SET status = 'released'
          WHERE reference = ?
            AND status = 'active'
        `).run(reference);
      }
    });

    // Serialize the conflict checks and booking write.
    saveResult.immediate();

    console.log('Paynow status result:', {
      reference,
      paynowStatus: rawStatus || 'unknown',
      recognisedAsPaid: nextStatus === 'paid',
      bookingCreated,
      bookingExists,
      bookingConflict
    });

    return res.json({
      success: true,
      reference,
      amount: tx.amount,
      status: nextStatus,
      paid: gatewayPaid,
      paynowStatus: rawStatus || 'unknown',
      paymentReviewRequired: paymentReversed,
      bookingCreated,
      bookingExists,
      bookingConflict,
      message: bookingConflict
        ? 'Payment is paid, but the room conflicts with another reservation. Manual resolution is required.'
        : paymentReversed
          ? 'Paynow reports a disputed or refunded payment. Manual review is required.'
          : undefined
    });
  } catch (error) {
    console.error('Paynow status poll failed:', error.message);

    return res.status(502).json({
      success: false,
      error: 'Could not check or save payment status. Please try again.'
    });
  }
});


/* ENQUIRY_API_V1_START */

// Public enquiry submission rate limit: 8 requests per IP per 10 minutes.
const enquirySubmissionAttempts = new Map();

function enquiryPublicRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  let entry = enquirySubmissionAttempts.get(ip);

  if (!entry || now - entry.startedAt >= 10 * 60 * 1000) {
    entry = { startedAt: now, count: 0 };
    enquirySubmissionAttempts.set(ip, entry);
  }

  if (entry.count >= 8) {
    return res.status(429).json({
      success: false,
      error: 'Too many enquiries. Please try again later.'
    });
  }

  entry.count++;
  next();
}

// Periodically clear expired rate-limit entries to prevent unbounded growth.
const enquiryRateLimitCleanup = setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;

  for (const [ip, entry] of enquirySubmissionAttempts) {
    if (entry.startedAt < cutoff) enquirySubmissionAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

if (typeof enquiryRateLimitCleanup.unref === 'function') {
  enquiryRateLimitCleanup.unref();
}

// Submit and permanently save an enquiry before the website opens WhatsApp.
app.post('/api/public/enquiries', enquiryPublicRateLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const message = req.body && req.body.message;

  if (typeof message !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Please enter a message.'
    });
  }

  const cleanMessage = message.trim();

  if (!cleanMessage || cleanMessage.length > 2000) {
    return res.status(400).json({
      success: false,
      error: 'Your message must contain between 1 and 2000 characters.'
    });
  }

  try {
    const createEnquiry = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO enquiries (message, status, source)
        VALUES (?, 'new', 'website')
      `).run(cleanMessage);

      const enquiryId = Number(result.lastInsertRowid);

      // Record the event without logging guest message or contact details.
      // This audit write shares the enquiry transaction.
      writeAudit(null, 'enquiry.created', 'enquiry', enquiryId, {
        source: 'website'
      });

      // Each active reception device gets its own alarm record.
      const devices = db.prepare(`
        SELECT device_id
        FROM enquiry_devices
        WHERE active = 1
      `).all();

      const createAlarm = db.prepare(`
        INSERT OR IGNORE INTO enquiry_alarms (enquiry_id, device_id)
        VALUES (?, ?)
      `);

      for (const device of devices) {
        createAlarm.run(enquiryId, device.device_id);
      }

      return {
        id: enquiryId,
        deviceCount: devices.length
      };
    });

    const created = createEnquiry.immediate();

    // Deliver push notifications after the enquiry is safely saved.
    // Notification failures must not undo or hide a saved enquiry.
    try {
      const tokens = db.prepare(`
        SELECT fcm_token
        FROM enquiry_devices
        WHERE active = 1
      `).all().map(device => device.fcm_token);

      const delivery = await sendEnquiryNotifications(tokens, {
        id: created.id,
        message: cleanMessage,
        status: 'new'
      });

      // Disable only tokens Firebase explicitly identifies as invalid.
      // Never write the token itself to logs or audit details.
      for (const invalidToken of delivery.invalidTokens || []) {
        const registeredDevice = db.prepare(`
          SELECT device_id, staff_id
          FROM enquiry_devices
          WHERE fcm_token = ? AND active = 1
        `).get(invalidToken);

        const deactivated = db.prepare(`
          UPDATE enquiry_devices
          SET active = 0, updated_at = CURRENT_TIMESTAMP
          WHERE fcm_token = ? AND active = 1
        `).run(invalidToken);

        if (deactivated.changes > 0 && registeredDevice) {
          writeAudit(
            null,
            'enquiry.device_token_invalidated',
            'device',
            registeredDevice.device_id,
            { reason: 'firebase_token_invalid' }
          );
        }
      }

      if (!delivery.skipped) {
        console.log(
          '[FCM] Enquiry', created.id,
          'delivery results:',
          delivery.successCount, 'sent,',
          delivery.failureCount, 'failed'
        );
      }
    } catch (pushError) {
      console.error(
        '[FCM] Notification attempt failed for enquiry',
        created.id,
        ':',
        pushError.code || pushError.message
      );
    }

    return res.status(201).json({
      success: true,
      enquiry: {
        id: created.id,
        message: cleanMessage,
        status: 'new'
      },
      notificationTargets: created.deviceCount
    });
  } catch (error) {
    console.error('Enquiry submission failed:', error.message);

    return res.status(500).json({
      success: false,
      error: 'We could not save your enquiry. Please try again.'
    });
  }
});

// Reception and authorised staff can load the inbox.
app.get(
  '/api/staff/enquiries',
  requireRole('developer', 'administrator', 'reception', 'read_only'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    try {
      const enquiries = db.prepare(`
        SELECT
          e.id,
          e.message,
          e.sender_name,
          e.sender_phone,
          e.sender_jid,
          e.status,
          e.source,
          e.created_at,
          e.updated_at,
          e.acknowledged_at,
          e.acknowledged_by_staff_id,
          COALESCE(e.acknowledged_by_username, ack_staff.username) AS acknowledged_by_username,
          (
            SELECT COUNT(*)
            FROM enquiry_alarms a
            WHERE a.enquiry_id = e.id
              AND a.dismissed_at IS NULL
          ) AS active_alarm_count
        FROM enquiries e
        LEFT JOIN staff ack_staff ON ack_staff.id = e.acknowledged_by_staff_id
        ORDER BY e.id DESC
        LIMIT 300
      `).all();

      return res.json({ success: true, enquiries });
    } catch (error) {
      console.error('Enquiry inbox failed:', error.message);

      return res.status(500).json({
        success: false,
        error: 'Unable to load enquiries.'
      });
    }
  }
);

// Retrieve one enquiry and its alarm state.
app.get(
  '/api/staff/enquiries/:id',
  requireRole('developer', 'administrator', 'reception', 'read_only'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid enquiry ID.'
      });
    }

    const enquiry = db.prepare(`
      SELECT e.id, e.message, e.sender_name, e.sender_phone, e.sender_jid, e.status, e.source, e.created_at, e.updated_at,
        e.acknowledged_at, e.acknowledged_by_staff_id,
        COALESCE(e.acknowledged_by_username, ack_staff.username) AS acknowledged_by_username
      FROM enquiries e
      LEFT JOIN staff ack_staff ON ack_staff.id = e.acknowledged_by_staff_id
      WHERE e.id = ?
    `).get(id);

    if (!enquiry) {
      return res.status(404).json({
        success: false,
        error: 'Enquiry not found.'
      });
    }

    const alarms = db.prepare(`
      SELECT
        a.device_id,
        a.dismissed_at,
        a.dismissed_by_staff_id,
        COALESCE(a.dismissed_by_username, s.username) AS dismissed_by_username,
        a.created_at
      FROM enquiry_alarms a
      LEFT JOIN staff s ON s.id = a.dismissed_by_staff_id
      WHERE a.enquiry_id = ?
      ORDER BY a.id
    `).all(id);

    return res.json({
      success: true,
      enquiry,
      alarms
    });
  }
);

// Update an enquiry's workflow status. Android clients may include device_id
// so the status change and this device's alarm dismissal happen atomically.
app.patch(
  '/api/staff/enquiries/:id/status',
  requireRole('developer', 'administrator', 'reception'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    const deviceId = req.body && Object.hasOwn(req.body, 'device_id') ? req.body.device_id : null;

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid enquiry ID.' });
    }
    if (!['new', 'acknowledged', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be new, acknowledged, or resolved.' });
    }
    if (deviceId !== null && (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId))) {
      return res.status(400).json({ success: false, error: 'Invalid device ID.' });
    }

    try {
      const result = updateEnquiryStatus(
        db,
        writeAudit,
        req.session.staff.id,
        id,
        status,
        deviceId,
        req.session.staff.username
      );
      if (!result) return res.status(404).json({ success: false, error: 'Enquiry not found.' });
      if (result.affectedDeviceIds && result.affectedDeviceIds.length) {
        notifyAlarmDismissal(result.enquiry.id, result.affectedDeviceIds, status).catch(error =>
          console.error('[FCM] Alarm-control delivery failed:', error.code || error.message)
        );
      }
      return res.json({ success: true, enquiry: result.enquiry, alarm: result.alarm });
    } catch (error) {
      if (error instanceof DeviceRegistrationError) {
        return res.status(403).json({ success: false, error: error.message, code: 'DEVICE_NOT_REGISTERED' });
      }
      console.error('Enquiry status update failed:', error.message);
      return res.status(500).json({ success: false, error: 'Unable to update enquiry status and device alarm.' });
    }
  }
);

// Register or refresh the authenticated staff member's Android device.
// Firebase delivery is handled by the existing push-notifications module.
app.post(
  '/api/staff/devices/register',
  requireRole('developer', 'administrator', 'reception'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    const deviceId = req.body && req.body.device_id;
    const fcmToken = req.body && req.body.fcm_token;

    if (
      typeof deviceId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(deviceId)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid device ID.'
      });
    }

    if (
      typeof fcmToken !== 'string' ||
      fcmToken.length < 20 ||
      fcmToken.length > 4096 ||
      /\s/.test(fcmToken)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Firebase device token.'
      });
    }

    try {
      db.prepare(`
        INSERT INTO enquiry_devices
          (device_id, staff_id, fcm_token, active, updated_at)
        VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(device_id) DO UPDATE SET
          staff_id = excluded.staff_id,
          fcm_token = excluded.fcm_token,
          active = 1,
          updated_at = CURRENT_TIMESTAMP
      `).run(deviceId, req.session.staff.id, fcmToken);

      // Create independent alarm records for existing unresolved enquiries.
      db.prepare(`
        INSERT OR IGNORE INTO enquiry_alarms (enquiry_id, device_id)
        SELECT id, ?
        FROM enquiries
        WHERE status != 'resolved'
      `).run(deviceId);

      writeAudit(
        req.session.staff.id,
        'enquiry.device_registered',
        'device',
        deviceId
      );

      return res.json({
        success: true,
        device_id: deviceId,
        message: 'Device registered.'
      });
    } catch (error) {
      console.error('Device registration failed:', error.message);

      return res.status(409).json({
        success: false,
        error: 'Device registration failed. Sign in again or refresh the device token.'
      });
    }
  }
);

// Disable the authenticated staff member's registered device.
app.post(
  '/api/staff/devices/unregister',
  requireRole('developer', 'administrator', 'reception'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    const deviceId = req.body && req.body.device_id;

    if (
      typeof deviceId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(deviceId)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid device ID.'
      });
    }

    const result = db.prepare(`
      UPDATE enquiry_devices
      SET active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE device_id = ? AND staff_id = ?
    `).run(deviceId, req.session.staff.id);

    if (!result.changes) {
      return res.status(404).json({
        success: false,
        error: 'Registered device not found.'
      });
    }

    writeAudit(
      req.session.staff.id,
      'enquiry.device_unregistered',
      'device',
      deviceId
    );

    return res.json({ success: true });
  }
);

// Deliver a server-authoritative stop command to every device whose alarm was closed.
async function notifyAlarmDismissal(enquiryId, deviceIds, status = 'dismissed') {
  const ids = [...new Set((deviceIds || []).filter(id => typeof id === 'string'))];
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const tokens = db.prepare(`SELECT fcm_token FROM enquiry_devices
    WHERE active = 1 AND device_id IN (${placeholders})`).all(...ids).map(row => row.fcm_token);
  if (!tokens.length) return;
  const result = await sendEnquiryAlarmControl(tokens, enquiryId, status);
  for (const token of result.invalidTokens || []) {
    db.prepare('UPDATE enquiry_devices SET active=0, updated_at=CURRENT_TIMESTAMP WHERE fcm_token=?').run(token);
  }
}

// Dismiss the selected enquiry's alarm on the authenticated device only.
// This endpoint is idempotent and returns that device's authoritative remaining alarm state.
app.post(
  '/api/staff/enquiries/:id/dismiss-alarm',
  requireRole('developer', 'administrator', 'reception'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = Number(req.params.id);
    const deviceId = req.body && req.body.device_id;

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid enquiry ID.' });
    }
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID.' });
    }

    try {
      const alarm = dismissDeviceAlarm(db, writeAudit, req.session.staff.id, id, deviceId, req.session.staff.username);
      if (!alarm) return res.status(404).json({ success: false, error: 'Enquiry not found.' });
      if (alarm.affectedDeviceIds && alarm.affectedDeviceIds.length) {
        notifyAlarmDismissal(id, alarm.affectedDeviceIds, 'dismissed').catch(error =>
          console.error('[FCM] Alarm-control delivery failed:', error.code || error.message)
        );
      }
      return res.json({ success: true, ...alarm, dismissedOnThisDevice: true });
    } catch (error) {
      if (error instanceof DeviceRegistrationError) {
        return res.status(403).json({ success: false, error: error.message, code: 'DEVICE_NOT_REGISTERED' });
      }
      console.error('Enquiry alarm dismissal failed:', error.message);
      return res.status(500).json({ success: false, error: 'Unable to dismiss this device alarm.' });
    }
  }
);

// Lightweight authoritative alarm-state query for one authenticated device.
app.get(
  '/api/staff/devices/:deviceId/active-alarms',
  requireRole('developer', 'administrator', 'reception'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');
    const deviceId = req.params.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      return res.status(400).json({ success: false, error: 'Invalid device ID.' });
    }
    try {
      const registered = db.prepare(`
        SELECT device_id FROM enquiry_devices
        WHERE device_id = ? AND staff_id = ? AND active = 1
      `).get(deviceId, req.session.staff.id);
      if (!registered) {
        return res.status(403).json({ success: false, error: 'This device is not registered to your active staff account.', code: 'DEVICE_NOT_REGISTERED' });
      }
      return res.json({ success: true, ...getDeviceAlarmState(db, deviceId) });
    } catch (error) {
      console.error('Device active alarm query failed:', error.message);
      return res.status(500).json({ success: false, error: 'Unable to retrieve active alarms for this device.' });
    }
  }
);

/* ENQUIRY_API_V1_END */


app.listen(PORT, () => {
  console.log(`\nThe Standard Hotel server is listening on port ${PORT}.`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`Paynow test credentials: ${configured() ? 'configured' : 'NOT configured'}`);
  console.log('Local test mode only. This demo does not create confirmed room reservations.');
  console.log('Keep server/.env private.\n');
});
