'use strict';

/** Prevent a caller from claiming a device ID or FCM token already owned elsewhere. */
function validateDeviceRegistration(db, staffId, deviceId, fcmToken) {
  const existingDevice = db.prepare('SELECT staff_id FROM enquiry_devices WHERE device_id=?').get(deviceId);
  if (existingDevice && Number(existingDevice.staff_id) !== Number(staffId)) {
    return { ok: false, status: 409, code: 'DEVICE_OWNERSHIP_CONFLICT', error: 'This device ID is already assigned to another staff account.' };
  }
  const existingToken = db.prepare('SELECT device_id FROM enquiry_devices WHERE fcm_token=? AND device_id<>? AND active=1').get(fcmToken, deviceId);
  if (existingToken) {
    return { ok: false, status: 409, code: 'FCM_TOKEN_ALREADY_REGISTERED', error: 'This Firebase token is already registered to another device.' };
  }
  return { ok: true };
}

/** Touch only an active device owned by the authenticated account. */
function touchGatewayDevice(db, staffId, deviceId) {
  const result = db.prepare(`UPDATE enquiry_devices SET last_seen_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE device_id=? AND staff_id=? AND active=1`).run(deviceId, staffId);
  if (!result.changes) return null;
  return db.prepare('SELECT last_seen_at FROM enquiry_devices WHERE device_id=? AND staff_id=?').get(deviceId, staffId);
}

/** Create alarm rows only for enquiries that are genuinely awaiting acknowledgement.
 * Acknowledged and resolved enquiries must never be re-armed for a newly registered device.
 */
function seedPendingEnquiryAlarmsForDevice(db, deviceId) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO enquiry_alarms (enquiry_id, device_id)
    SELECT id, ? FROM enquiries WHERE status = 'new'
  `).run(deviceId);
  return Number(result.changes || 0);
}

module.exports = { validateDeviceRegistration, touchGatewayDevice, seedPendingEnquiryAlarmsForDevice };
