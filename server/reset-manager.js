'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLES = ['developer', 'administrator', 'reception', 'read_only'];
const CATEGORIES = [
  {
    key: 'booking_holds', group: 'Reception test data', label: 'Temporary booking holds',
    description: 'Temporary room holds only. Confirmed bookings and payment records are not deleted.',
    warning: 'Active holds may be released; guests may need to restart an unfinished booking.',
    table: 'booking_holds'
  },
  {
    key: 'enquiry_alarms', group: 'Reception test data', label: 'Reception alarm records',
    description: 'Clears active and dismissed alarm records while preserving the underlying guest enquiries.',
    warning: 'Alarm history and active alarm assignments will be cleared. Unresolved enquiries remain in the inbox.',
    table: 'enquiry_alarms'
  },
  {
    key: 'test_enquiries', group: 'Reception test data', label: 'Marked system-test enquiries',
    description: 'Deletes only enquiries explicitly marked with source system_test or the [SYSTEM TEST] message prefix. Unmarked guest enquiries are preserved.',
    warning: 'Only clearly marked system-test entries and their linked alarms are deleted.',
    table: 'enquiries',
    where: "source = 'system_test' OR message LIKE '[SYSTEM TEST]%'"
  },
  {
    key: 'enquiries', group: 'Reception test data', label: 'All reception enquiries',
    description: 'Deletes every reception enquiry and its linked alarm records. This includes genuine guest submissions, not only test messages.',
    warning: 'HIGH IMPACT: all guest enquiries will be permanently deleted. Only use on staging/test data after exporting anything that must be retained.',
    table: 'enquiries'
  },
  {
    key: 'enquiry_devices', group: 'Reception test data', label: 'Registered reception devices',
    description: 'Removes registered Android reception devices and their stored Firebase push tokens. Staff accounts are preserved.',
    warning: 'Android devices will stop receiving push alerts until staff sign in again and the devices register again.',
    table: 'enquiry_devices'
  },
  {
    key: 'reviews', group: 'Website test data', label: 'Guest reviews',
    description: 'Deletes all saved review entries, including drafts and published reviews.',
    warning: 'Published guest reviews will disappear from the website.',
    table: 'reviews'
  },
  {
    key: 'content_items', group: 'Website test data', label: 'CMS content items',
    description: 'Deletes CMS news and content entries. Website settings and uploaded files are untouched.',
    warning: 'All content_items records will be permanently deleted.',
    table: 'content_items'
  },
  {
    key: 'audit_log', group: 'Activity history', label: 'Audit / activity history',
    description: 'Clears existing management audit entries. The reset itself remains recorded separately and a new audit entry is written afterwards.',
    warning: 'Previous audit history will be cleared. Reset operation history is retained.',
    table: 'audit_log'
  },
  {
    key: 'web_sessions', group: 'Access and sessions', label: 'All staff web sessions',
    description: 'Signs all staff users out of the website. Staff accounts and passwords remain unchanged.',
    warning: 'Everyone will need to sign in again, including the person performing this reset.',
    table: 'web_sessions'
  }
];

const DEFAULT_PERMISSIONS = {
  developer: new Set(CATEGORIES.map(c => c.key)),
  administrator: new Set(),
  reception: new Set(),
  read_only: new Set()
};

function installResetManager(app, db, requireAuth, writeAudit, options = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reset_role_permissions (
      role TEXT NOT NULL,
      category_key TEXT NOT NULL,
      can_execute INTEGER NOT NULL DEFAULT 0 CHECK (can_execute IN (0,1)),
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (role, category_key),
      FOREIGN KEY (updated_by) REFERENCES staff(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS reset_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_staff_id INTEGER,
      actor_username TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      backup_file TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (actor_staff_id) REFERENCES staff(id) ON DELETE SET NULL
    );
  `);

  const seed = db.prepare(`INSERT OR IGNORE INTO reset_role_permissions
    (role, category_key, can_execute) VALUES (?, ?, ?)`);
  for (const role of ROLES) {
    for (const category of CATEGORIES) {
      seed.run(role, category.key, DEFAULT_PERMISSIONS[role].has(category.key) ? 1 : 0);
    }
  }

  const previews = new Map();
  const categoryByKey = new Map(CATEGORIES.map(c => [c.key, c]));
  const countFor = key => {
    const category = categoryByKey.get(key);
    const where = category.where ? ` WHERE ${category.where}` : '';
    return db.prepare(`SELECT COUNT(*) AS count FROM ${category.table}${where}`).get().count;
  };
  const permissionsFor = role => {
    if (role === 'developer') return new Set(CATEGORIES.map(c => c.key));
    const rows = db.prepare('SELECT category_key FROM reset_role_permissions WHERE role = ? AND can_execute = 1').all(role);
    return new Set(rows.map(r => r.category_key));
  };
  const cleanKeys = (keys) => {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > CATEGORIES.length) {
      throw new Error('Select at least one reset category.');
    }
    const unique = [...new Set(keys)];
    if (unique.some(k => typeof k !== 'string' || !categoryByKey.has(k))) {
      throw new Error('One or more reset categories are invalid.');
    }
    return unique;
  };
  const canUse = (role, keys) => {
    const allowed = permissionsFor(role);
    return keys.every(k => allowed.has(k));
  };
  const countSnapshot = keys => Object.fromEntries(keys.map(k => [k, countFor(k)]));
  const expirePreviews = () => {
    const cutoff = Date.now();
    for (const [id, p] of previews) if (p.expiresAt <= cutoff) previews.delete(id);
  };
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  app.get('/api/admin/reset-options', requireAuth, noStore, (req, res) => {
    const role = req.session.staff.role;
    const allowed = permissionsFor(role);
    res.json({
      success: true,
      categories: CATEGORIES.map(({ table, ...c }) => ({ ...c, count: countFor(c.key), canExecute: allowed.has(c.key) })),
      presets: [
        { key: 'clean_reception', label: 'Clean reception test data', categories: ['booking_holds', 'enquiry_alarms', 'test_enquiries'] },
        { key: 'clear_all_enquiries', label: 'Clear all reception enquiries', categories: ['enquiries'] },
        { key: 'clear_website_test', label: 'Clear website test content', categories: ['reviews', 'content_items'] },
        { key: 'clear_activity', label: 'Clear activity history', categories: ['audit_log'] },
        { key: 'unregister_devices', label: 'Unregister reception devices', categories: ['enquiry_devices'] },
        { key: 'sign_out_all', label: 'Sign out all staff', categories: ['web_sessions'] }
      ],
      role
    });
  });

  app.get('/api/admin/reset-permissions', requireAuth, noStore, (req, res) => {
    if (req.session.staff.role !== 'developer') return res.status(403).json({ success: false, error: 'Only the developer can configure reset permissions.' });
    const rows = db.prepare('SELECT role, category_key, can_execute FROM reset_role_permissions ORDER BY role, category_key').all();
    res.json({ success: true, roles: ROLES.filter(r => r !== 'developer'), categories: CATEGORIES.map(c => ({ key: c.key, label: c.label })), permissions: rows });
  });

  app.put('/api/admin/reset-permissions', requireAuth, noStore, (req, res) => {
    if (req.session.staff.role !== 'developer') return res.status(403).json({ success: false, error: 'Only the developer can configure reset permissions.' });
    const permissions = req.body?.permissions;
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return res.status(400).json({ success: false, error: 'A permissions object is required.' });
    try {
      const allowedKeys = new Set(CATEGORIES.map(c => c.key));
      const update = db.transaction(() => {
        for (const role of ROLES.filter(r => r !== 'developer')) {
          const selected = permissions[role];
          if (!Array.isArray(selected) || selected.some(k => !allowedKeys.has(k))) throw new Error(`Invalid permissions for ${role}.`);
          const selectedSet = new Set(selected);
          for (const category of CATEGORIES) {
            db.prepare(`UPDATE reset_role_permissions SET can_execute = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE role = ? AND category_key = ?`)
              .run(selectedSet.has(category.key) ? 1 : 0, req.session.staff.id, role, category.key);
          }
        }
        writeAudit(req.session.staff.id, 'reset.permissions.updated', 'reset_permissions', 'roles', { roles: ROLES.filter(r => r !== 'developer') });
      });
      update.immediate();
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/admin/reset-preview', requireAuth, noStore, (req, res) => {
    try {
      expirePreviews();
      const keys = cleanKeys(req.body?.categories);
      const role = req.session.staff.role;
      if (!canUse(role, keys)) return res.status(403).json({ success: false, error: 'Your role is not permitted to reset one or more selected categories.' });
      const counts = countSnapshot(keys);
      const previewId = crypto.randomBytes(24).toString('hex');
      previews.set(previewId, {
        staffId: req.session.staff.id,
        role,
        keys,
        counts,
        expiresAt: Date.now() + 5 * 60 * 1000
      });
      const warnings = keys.map(k => ({ key: k, warning: categoryByKey.get(k).warning }));
      res.json({ success: true, previewId, expiresInSeconds: 300, counts, totalRecords: Object.values(counts).reduce((a, b) => a + b, 0), warnings });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/admin/reset-execute', requireAuth, noStore, (req, res) => {
    expirePreviews();
    const previewId = req.body?.previewId;
    const confirmation = req.body?.confirmation;
    const preview = typeof previewId === 'string' ? previews.get(previewId) : null;
    if (!preview || preview.staffId !== req.session.staff.id || preview.role !== req.session.staff.role) {
      return res.status(400).json({ success: false, error: 'This reset preview is missing, expired or belongs to another user. Create a new preview.' });
    }
    if (confirmation !== 'RESET') return res.status(400).json({ success: false, error: 'Type RESET exactly to confirm this operation.' });
    if (!canUse(req.session.staff.role, preview.keys)) return res.status(403).json({ success: false, error: 'Your reset permissions have changed. Create a new preview.' });

    const currentCounts = countSnapshot(preview.keys);
    if (JSON.stringify(currentCounts) !== JSON.stringify(preview.counts)) {
      previews.delete(previewId);
      return res.status(409).json({ success: false, error: 'The selected record counts changed after preview. Review a fresh preview before continuing.', counts: currentCounts });
    }

    const backupDir = options.backupDir || path.join(__dirname, 'data', 'backups');
    let backupFile;
    try {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(backupDir, 0o700); } catch (_) {}
      backupFile = path.join(backupDir, `pre-reset-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
      const quotedBackup = backupFile.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${quotedBackup}'`);
      try { fs.chmodSync(backupFile, 0o600); } catch (_) {}

      const deletedCounts = {};
      const execute = db.transaction(() => {
        // Recheck under the write lock so no records can slip in after preview.
        const lockedCounts = countSnapshot(preview.keys);
        if (JSON.stringify(lockedCounts) !== JSON.stringify(preview.counts)) {
          const stale = new Error('RESET_PREVIEW_STALE');
          stale.code = 'RESET_PREVIEW_STALE';
          throw stale;
        }
        // Static allowlist only: table names are never accepted from the client.
        for (const key of preview.keys) {
          const category = categoryByKey.get(key);
          const where = category.where ? ` WHERE ${category.where}` : '';
          const result = db.prepare(`DELETE FROM ${category.table}${where}`).run();
          deletedCounts[key] = Number(result.changes || 0);
        }
        const actor = req.session.staff;
        db.prepare(`INSERT INTO reset_operations
          (actor_staff_id, actor_username, categories_json, counts_json, backup_file)
          VALUES (?, ?, ?, ?, ?)`)
          .run(actor.id, actor.username, JSON.stringify(preview.keys), JSON.stringify(deletedCounts), path.basename(backupFile));
        // If audit history was selected, this is a fresh record describing the reset;
        // the durable reset_operations row above remains even if audit_log is cleared.
        writeAudit(actor.id, 'data.reset.executed', 'reset', 'selected_categories', {
          categories: preview.keys,
          deletedCounts,
          backup: path.basename(backupFile)
        });
      });
      execute.immediate();
      previews.delete(previewId);

      const clearedSessions = preview.keys.includes('web_sessions');
      const finish = () => {
        res.json({ success: true, deletedCounts, totalDeleted: Object.values(deletedCounts).reduce((a, b) => a + b, 0), backupAvailable: true, signedOutAllStaff: clearedSessions });
      };
      if (clearedSessions) {
        req.session.destroy(error => {
          res.clearCookie('sth.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
          if (error) return res.status(500).json({ success: false, error: 'Reset completed, but this session could not be cleared. Please sign out manually.' });
          finish();
        });
      } else finish();
    } catch (error) {
      if (error.code === 'RESET_PREVIEW_STALE') {
        previews.delete(previewId);
        return res.status(409).json({ success: false, error: 'The selected record counts changed while the reset was being prepared. Review a fresh preview before continuing.' });
      }
      console.error('Reset operation failed:', error.message);
      return res.status(500).json({ success: false, error: 'Reset failed. The database transaction was rolled back. The pre-reset backup, if created, has been retained.' });
    }
  });

  app.get('/api/admin/reset-history', requireAuth, noStore, (req, res) => {
    if (req.session.staff.role !== 'developer' && req.session.staff.role !== 'administrator') return res.status(403).json({ success: false, error: 'Insufficient permissions.' });
    const operations = db.prepare(`SELECT id, actor_staff_id, actor_username, categories_json, counts_json, created_at
      FROM reset_operations ORDER BY id DESC LIMIT 100`).all().map(row => ({
        ...row,
        categories: JSON.parse(row.categories_json),
        counts: JSON.parse(row.counts_json)
      }));
    res.json({ success: true, operations });
  });
}

module.exports = { installResetManager };
