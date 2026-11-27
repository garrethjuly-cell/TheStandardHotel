'use strict';
// Railway's filesystem is wiped on every deploy. If a volume is attached, keep the
// SQLite database and CMS uploads on it by symlinking them into the volume.
const fs = require('fs');
const path = require('path');

function persist(volumeSubdir, appDir) {
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!vol) return;
  const target = path.join(vol, volumeSubdir);
  fs.mkdirSync(target, { recursive: true });
  let stat = null;
  try { stat = fs.lstatSync(appDir); } catch (_) {}
  if (stat && stat.isSymbolicLink()) return;
  if (stat && stat.isDirectory()) {
    if (fs.readdirSync(target).length === 0) fs.cpSync(appDir, target, { recursive: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  fs.symlinkSync(target, appDir, 'dir');
}

persist('db', path.join(__dirname, 'server', 'data'));
persist('uploads', path.join(__dirname, 'assets', 'uploads'));
require('./server/server.js');
