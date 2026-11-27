'use strict';

const { DEVICE_ID_PATTERN } = require('./enquiry-alarm-service');

/** Resolve the dashboard's current device safely.
 * Older Android builds omit device_id. In that case, infer it only when the
 * authenticated staff member has exactly one active registered device.
 */
function getDashboardDeviceAlarmCount(db, staffId, requestedDeviceId = '') {
  const devices = db.prepare(`
    SELECT device_id FROM enquiry_devices
    WHERE staff_id = ? AND active = 1
    ORDER BY device_id
  `).all(staffId).map(row => row.device_id);

  let deviceId = requestedDeviceId;
  let scope = 'explicit_device';

  if (deviceId) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      return { error: 'INVALID_DEVICE_ID' };
    }
    if (!devices.includes(deviceId)) return { error: 'DEVICE_NOT_REGISTERED' };
  } else if (devices.length === 1) {
    deviceId = devices[0];
    scope = 'inferred_single_registered_device';
  } else {
    return {
      activeAlarmsForThisDevice: 0,
      dashboardDeviceId: null,
      activeAlarmScope: devices.length ? 'device_id_required_multiple_devices' : 'no_registered_device'
    };
  }

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM enquiry_alarms a
    INNER JOIN enquiries e ON e.id = a.enquiry_id
    WHERE a.device_id = ?
      AND a.dismissed_at IS NULL
      AND e.status NOT IN ('acknowledged', 'resolved')
  `).get(deviceId);

  return {
    activeAlarmsForThisDevice: Number(row.count || 0),
    dashboardDeviceId: deviceId,
    activeAlarmScope: scope
  };
}

module.exports = { getDashboardDeviceAlarmCount };
