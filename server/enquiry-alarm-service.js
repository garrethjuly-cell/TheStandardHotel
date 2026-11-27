'use strict';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

class DeviceRegistrationError extends Error {
  constructor() {
    super('This device is not registered to your active staff account. Refresh device registration and try again.');
    this.name = 'DeviceRegistrationError';
    this.statusCode = 403;
  }
}

function getDeviceAlarmState(db, deviceId) {
  const activeAlarmEnquiryIds = db.prepare(`
    SELECT a.enquiry_id
    FROM enquiry_alarms a
    INNER JOIN enquiries e ON e.id = a.enquiry_id
    WHERE a.device_id = ?
      AND a.dismissed_at IS NULL
      AND e.status NOT IN ('acknowledged', 'resolved')
    ORDER BY a.enquiry_id
  `).all(deviceId).map(row => Number(row.enquiry_id));
  return { deviceId, deviceHasRemainingAlarms: activeAlarmEnquiryIds.length > 0, activeAlarmEnquiryIds };
}

function assertActiveDevice(db, staffId, deviceId) {
  const registered = db.prepare(`SELECT device_id FROM enquiry_devices WHERE device_id = ? AND staff_id = ? AND active = 1`).get(deviceId, staffId);
  if (!registered) throw new DeviceRegistrationError();
}

/** Acknowledgement and resolution close the selected enquiry's alarm on all registered devices.
 * Manual dismissal is device-scoped; other devices and other enquiries remain untouched.
 */
function updateEnquiryStatus(db, writeAudit, staffId, enquiryId, status, deviceId = null, actorUsername = null) {
  if (deviceId !== null) assertActiveDevice(db, staffId, deviceId);
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT id, status FROM enquiries WHERE id = ?').get(enquiryId);
    if (!existing) return null;
    const username = actorUsername == null ? null : String(actorUsername);
    db.prepare('UPDATE enquiries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, enquiryId);

    if (status === 'acknowledged') {
      db.prepare(`UPDATE enquiries
        SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_staff_id = ?, acknowledged_by_username = ?
        WHERE id = ?`).run(staffId, username, enquiryId);
      const timestamp = db.prepare('SELECT acknowledged_at AS timestamp FROM enquiries WHERE id = ?').get(enquiryId).timestamp;
      writeAudit(staffId, 'enquiry.acknowledged', 'enquiry', enquiryId, {
        actor_username: username, timestamp, ...(deviceId ? { device_id: deviceId } : {})
      });
    }

    let affectedDeviceIds = [];
    if (status === 'acknowledged' || status === 'resolved') {
      const pending = db.prepare(`SELECT device_id FROM enquiry_alarms WHERE enquiry_id = ? AND dismissed_at IS NULL ORDER BY device_id`).all(enquiryId);
      affectedDeviceIds = pending.map(row => row.device_id);
      for (const row of pending) {
        db.prepare(`UPDATE enquiry_alarms
          SET dismissed_at = CURRENT_TIMESTAMP, dismissed_by_staff_id = ?, dismissed_by_username = ?
          WHERE enquiry_id = ? AND device_id = ? AND dismissed_at IS NULL`).run(staffId, username, enquiryId, row.device_id);
        const timestamp = db.prepare('SELECT dismissed_at AS timestamp FROM enquiry_alarms WHERE enquiry_id = ? AND device_id = ?').get(enquiryId, row.device_id).timestamp;
        writeAudit(staffId, 'enquiry.alarm_dismissed', 'enquiry', enquiryId, {
          actor_username: username, device_id: row.device_id, timestamp, reason: status
        });
      }
    }
    if (existing.status !== status) writeAudit(staffId, 'enquiry.status_updated', 'enquiry', enquiryId, { actor_username: username, from: existing.status, to: status, ...(deviceId ? { device_id: deviceId } : {}) });

    const enquiry = db.prepare(`SELECT id, message, status, source, created_at, updated_at,
      acknowledged_at, acknowledged_by_staff_id, acknowledged_by_username
      FROM enquiries WHERE id = ?`).get(enquiryId);
    return { enquiry, alarm: deviceId ? { dismissed: status !== 'new', ...getDeviceAlarmState(db, deviceId) } : null, affectedDeviceIds };
  });
  return tx.immediate();
}

function dismissDeviceAlarm(db, writeAudit, staffId, enquiryId, deviceId, actorUsername = null) {
  assertActiveDevice(db, staffId, deviceId);
  const tx = db.transaction(() => {
    const enquiry = db.prepare('SELECT id FROM enquiries WHERE id = ?').get(enquiryId);
    if (!enquiry) return null;

    const username = actorUsername == null ? null : String(actorUsername);
    const result = db.prepare(`UPDATE enquiry_alarms
      SET dismissed_at = CURRENT_TIMESTAMP, dismissed_by_staff_id = ?, dismissed_by_username = ?
      WHERE enquiry_id = ? AND device_id = ? AND dismissed_at IS NULL`).run(staffId, username, enquiryId, deviceId);
    const dismissed = Number(result.changes || 0) === 1;

    if (dismissed) {
      const timestamp = db.prepare('SELECT dismissed_at FROM enquiry_alarms WHERE enquiry_id = ? AND device_id = ?').get(enquiryId, deviceId).dismissed_at;
      writeAudit(staffId, 'enquiry.alarm_dismissed', 'enquiry', enquiryId, {
        actor_username: username, device_id: deviceId, initiated_by_device_id: deviceId,
        timestamp, reason: 'manual_device_dismissal'
      });
    }

    const alarm = db.prepare(`SELECT device_id, dismissed_at, dismissed_by_staff_id, dismissed_by_username, created_at
      FROM enquiry_alarms WHERE enquiry_id = ? AND device_id = ?`).get(enquiryId, deviceId) || null;
    return {
      dismissed,
      alreadyDismissed: !dismissed,
      alarm,
      affectedDeviceIds: dismissed ? [deviceId] : [],
      dismissedDeviceIds: alarm && alarm.dismissed_at ? [deviceId] : [],
      ...getDeviceAlarmState(db, deviceId)
    };
  });
  return tx.immediate();
}

module.exports = { DEVICE_ID_PATTERN, DeviceRegistrationError, getDeviceAlarmState, updateEnquiryStatus, dismissDeviceAlarm };
