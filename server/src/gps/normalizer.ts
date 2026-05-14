/**
 * GPS Normalizer
 * Transforms raw database rows into normalized GpsPosition model
 */

import { config } from '../config/env';
import { GpsRawRow } from './dto/gps-raw-row.dto';
import { GpsPosition } from './dto/gps-position.dto';

/**
 * Normalize a single raw GPS row to internal GpsPosition model
 * @throws Error if critical fields are missing or invalid
 */
export function normalize(raw: GpsRawRow): GpsPosition {
  // Validate required fields exist
  if (raw.imei === undefined || raw.imei === null || raw.imei === '') {
    throw new Error('Missing required field: imei');
  }
  if (raw.latitude === undefined || raw.latitude === null) {
    throw new Error('Missing required field: latitude');
  }
  if (raw.longitude === undefined || raw.longitude === null) {
    throw new Error('Missing required field: longitude');
  }
  if (raw.ts === undefined || raw.ts === null) {
    throw new Error('Missing required field: ts');
  }
  if (raw.license_plate === undefined || raw.license_plate === null) {
    throw new Error('Missing required field: license_plate');
  }
  if (raw.speed === undefined || raw.speed === null) {
    throw new Error('Missing required field: speed');
  }
  if (raw.direction_id === undefined || raw.direction_id === null) {
    throw new Error('Missing required field: direction_id');
  }
  if (raw.driver_id === undefined || raw.driver_id === null) {
    throw new Error('Missing required field: driver_id');
  }
  if (raw.tsinitialtrip === undefined || raw.tsinitialtrip === null) {
    throw new Error('Missing required field: tsinitialtrip');
  }

  // Normalize direction: 0 = IDA, 1 = VUELTA
  const direction: 'IDA' | 'VUELTA' = raw.direction_id === 0 ? 'IDA' : 'VUELTA';

  // Apply speed unit conversion: Traccar stores speed in knots by default
  // Convert to km/h if configured (knots * 1.852 = km/h)
  let speed = Number(raw.speed);
  if (config.gps.speedUnit === 'knots') {
    speed = Math.round(speed * 1.852 * 10) / 10; // Convert and round to 1 decimal
  } else {
    speed = Math.round(speed * 10) / 10; // Round to 1 decimal
  }

  const gpsTimestamp = Number(raw.ts);
  const tripStartTimestamp = Number(raw.tsinitialtrip);
  // NOTA: tsinitialtrip debe ser CONSTANTE durante todo el viaje.
  // NO se debe reemplazar con gpsTimestamp — eso haría que cambie cada 5s.
  // Si tsinitialtrip > ts, el validator lo rechaza como validation_failed.

  return {
    deviceImei: String(raw.imei).trim(),
    plate: String(raw.license_plate).trim(),
    latitude: Math.round(Number(raw.latitude) * 1000000) / 1000000, // 6 decimals
    longitude: Math.round(Number(raw.longitude) * 1000000) / 1000000, // 6 decimals
    speed: speed,
    gpsTimestamp: gpsTimestamp,
    routeCode: String(raw.route_id || '').trim(),
    direction: direction,
    driverDocument: String(raw.driver_id).trim(),
    tripStartTimestamp: tripStartTimestamp,
  };
}

/**
 * Normalize a batch of raw GPS rows
 * @returns Array of normalized GpsPosition objects
 */
export function normalizeBatch(rows: GpsRawRow[]): GpsPosition[] {
  return rows.map(row => normalize(row));
}
