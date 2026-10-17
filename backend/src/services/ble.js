import { HttpError } from '../errors.js';

/**
 * BLE proximity check.
 * The browser/phone scans for the classroom beacon and reports which beacon
 * it saw and the signal strength (RSSI, dBm; closer = less negative).
 */
export function checkBle(app, session, { beaconId, rssi }) {
  const { config } = app;
  if (typeof beaconId !== 'string' || !beaconId.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', '`beaconId` is required.');
  }
  if (typeof rssi !== 'number' || !Number.isFinite(rssi) || rssi > 0 || rssi < -127) {
    throw new HttpError(400, 'VALIDATION_ERROR', '`rssi` must be a negative number in dBm (e.g. -62).');
  }
  if (beaconId.trim().toLowerCase() !== session.beacon_id.toLowerCase()) {
    throw new HttpError(422, 'BLE_BEACON_MISMATCH', "That isn't this classroom's beacon.");
  }
  if (rssi < config.bleMinRssi) {
    throw new HttpError(422, 'BLE_TOO_FAR', 'You appear to be outside the classroom range. Move closer and try again.', {
      rssi, minRssi: config.bleMinRssi,
    });
  }
  return { rssi: Math.round(rssi) };
}
