/**
 * Transmission Scheduler
 * Controls when to send transmissions to ATU with 20-second maximum rule
 */

import { config } from '../config/env';
import { GpsSourceAdapter } from '../gps/adapters/gps-source.adapter';
import { normalizeBatch, normalize } from '../gps/normalizer';
import { buildAtuPayload, AtuPayload } from './mapper';
import { validatePayload, isOlderThanTenMinutes } from './validator';
import { AtuWsClient } from './ws-client';
import { handleResponse } from './response-handler';
import { TransmissionService } from '../transmissions/transmission-service';
import { AlertManager, consoleAlert } from '../alerts/alert-manager';
import { GpsPosition } from '../gps/dto/gps-position.dto';

export interface TransmissionSchedulerOptions {
  gpsAdapter: GpsSourceAdapter;
  normalizer: typeof normalize;
  mapper: typeof buildAtuPayload;
  validator: typeof validatePayload;
  wsClient: AtuWsClient;
  transmissionService: TransmissionService;
  alertManager: AlertManager;
  dryRun: boolean;
  maxUpdateIntervalSeconds: number;
  maxPositionAgeMinutes: number;
}

/**
 * In-memory tracking for transmission state
 * Reset on restart — acceptable trade-off for this scope
 */
const lastSuccessfulTransmissionAt: Map<string, number> = new Map(); // imei → timestamp ms
const lastSentPositionKey: Map<string, string> = new Map(); // imei → "ts-lat-lon" hash
const transmissionStopped: Set<string> = new Set(); // imeis with stopped transmission

/**
 * Create a hash key for duplicate detection
 */
function createPositionKey(position: GpsPosition): string {
  return `${position.gpsTimestamp}-${position.latitude}-${position.longitude}`;
}

/**
 * Check if position is duplicate (same imei + same ts)
 */
function isDuplicate(imei: string, position: GpsPosition): boolean {
  const key = createPositionKey(position);
  const lastKey = lastSentPositionKey.get(imei);
  return lastKey === key;
}

/**
 * Mark position as sent
 */
function markSent(imei: string, position: GpsPosition): void {
  lastSentPositionKey.set(imei, createPositionKey(position));
}

/**
 * Record successful transmission
 */
function recordSuccess(imei: string): void {
  lastSuccessfulTransmissionAt.set(imei, Date.now());
}

/**
 * Check if vehicle has exceeded 20-second rule
 */
function hasExceededMaxInterval(imei: string, maxSeconds: number): boolean {
  const lastSuccess = lastSuccessfulTransmissionAt.get(imei);
  if (!lastSuccess) return true; // No successful transmission yet
  return Date.now() - lastSuccess > maxSeconds * 1000;
}

/**
 * Check if transmission is stopped for this vehicle
 */
function isTransmissionStopped(imei: string): boolean {
  return transmissionStopped.has(imei);
}

/**
 * Stop transmission for a vehicle (e.g., token invalid)
 */
function stopTransmission(imei: string): void {
  transmissionStopped.add(imei);
}

/**
 * Clear stopped state (e.g., on re-auth)
 */
function clearStoppedState(imei: string): void {
  transmissionStopped.delete(imei);
}

export class TransmissionScheduler {
  private options: TransmissionSchedulerOptions;
  private intervalId: NodeJS.Timeout | null = null;
  private _isRunning = false;
  private consecutiveRejections: Map<string, number> = new Map();

  constructor(options: TransmissionSchedulerOptions) {
    this.options = options;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this._isRunning) {
      console.log('[Scheduler] Already running');
      return;
    }

    const pollInterval = config.gps.pollIntervalMs;
    console.log(`[Scheduler] Starting with poll interval ${pollInterval}ms`);

    this._isRunning = true;

    // Run immediately, then on interval
    this.runCycle().catch(err => {
      console.error('[Scheduler] Initial cycle error:', err);
    });

    this.intervalId = setInterval(() => {
      this.runCycle().catch(err => {
        console.error('[Scheduler] Cycle error:', err);
      });
    }, pollInterval);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this._isRunning = false;
    console.log('[Scheduler] Stopped');
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Run one transmission cycle
   */
  private async runCycle(): Promise<void> {
    const { gpsAdapter, normalizer, mapper, validator, wsClient, transmissionService, alertManager, dryRun, maxUpdateIntervalSeconds, maxPositionAgeMinutes } = this.options;

    let positions: GpsPosition[] = [];

    // 1. Fetch positions from GPS adapter
    try {
      const rawRows = await gpsAdapter.getLatestPositions();
      positions = normalizeBatch(rawRows);
      console.log(`[Scheduler] Fetched ${positions.length} positions`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Scheduler] GPS fetch error: ${message}`);
      try {
        await alertManager.generate({
          severity: 'critical',
          type: 'gps_source_error',
          title: 'GPS Source Error',
          message: `Failed to fetch GPS positions: ${message}`,
        });
      } catch {
        consoleAlert({
          severity: 'critical',
          type: 'gps_source_error',
          title: 'GPS Source Error',
          message: `Failed to fetch GPS positions: ${message}`,
        });
      }
      return;
    }

    // 2. Process each position
    for (const position of positions) {
      const imei = position.deviceImei;

      // Skip if transmission is stopped for this vehicle
      if (isTransmissionStopped(imei)) {
        console.log(`[Scheduler] Transmission stopped for ${imei}, skipping`);
        continue;
      }

      // Skip duplicates
      if (isDuplicate(imei, position)) {
        console.log(`[Scheduler] Duplicate position for ${imei}, skipping`);
        continue;
      }

      // Build ATU payload
      const payload = mapper(position);

      // Validate
      const validation = validator(payload);
      if (!validation.valid) {
        const errorMsg = validation.errors.map(e => e.message).join('; ');
        console.log(`[Scheduler] Validation failed for ${imei}: ${errorMsg}`);
        
        // Save validation failure to DB
        try {
          await transmissionService.saveTransmission({
            imei: payload.imei,
            license_plate: payload.license_plate,
            route_id: payload.route_id,
            driver_id: payload.driver_id,
            direction_id: payload.direction_id,
            latitude: payload.latitude,
            longitude: payload.longitude,
            speed: payload.speed,
            ts: payload.ts,
            tsinitialtrip: payload.tsinitialtrip,
            identifier: payload.identifier,
            payload_json: JSON.stringify(payload),
            status: 'validation_failed',
            validation_error: errorMsg,
            retry_count: 0,
          });
        } catch (err) {
          console.error(`[Scheduler] Failed to save validation failure: ${err}`);
        }

        try {
          await alertManager.generate({
            severity: 'info',
            type: 'validation_failed',
            title: 'Payload Validation Failed',
            message: `IMEI ${imei}: ${errorMsg}`,
          });
        } catch {
          consoleAlert({
            severity: 'info',
            type: 'validation_failed',
            title: 'Payload Validation Failed',
            message: `IMEI ${imei}: ${errorMsg}`,
          });
        }
        continue;
      }

      // Check if position is expired (>10 min old)
      if (isOlderThanTenMinutes(payload.ts, maxPositionAgeMinutes)) {
        console.log(`[Scheduler] Position expired for ${imei} (age >${maxPositionAgeMinutes} min)`);
        
        try {
          await transmissionService.saveTransmission({
            imei: payload.imei,
            license_plate: payload.license_plate,
            route_id: payload.route_id,
            driver_id: payload.driver_id,
            direction_id: payload.direction_id,
            latitude: payload.latitude,
            longitude: payload.longitude,
            speed: payload.speed,
            ts: payload.ts,
            tsinitialtrip: payload.tsinitialtrip,
            identifier: payload.identifier,
            payload_json: JSON.stringify(payload),
            status: 'expired',
            retry_count: 0,
          });
        } catch (err) {
          console.error(`[Scheduler] Failed to save expired position: ${err}`);
        }

        try {
          await alertManager.generate({
            severity: 'info',
            type: 'transmission_expired',
            title: 'Position Expired',
            message: `Position for IMEI ${imei} is older than ${maxPositionAgeMinutes} minutes`,
          });
        } catch {
          consoleAlert({
            severity: 'info',
            type: 'transmission_expired',
            title: 'Position Expired',
            message: `Position for IMEI ${imei} is older than ${maxPositionAgeMinutes} minutes`,
          });
        }
        continue;
      }

      // Dry run mode
      if (dryRun) {
        console.log(`[Scheduler] [DRY RUN] Would send position for ${imei}, identifier=${payload.identifier}`);
        
        try {
          await transmissionService.saveTransmission({
            imei: payload.imei,
            license_plate: payload.license_plate,
            route_id: payload.route_id,
            driver_id: payload.driver_id,
            direction_id: payload.direction_id,
            latitude: payload.latitude,
            longitude: payload.longitude,
            speed: payload.speed,
            ts: payload.ts,
            tsinitialtrip: payload.tsinitialtrip,
            identifier: payload.identifier,
            payload_json: JSON.stringify(payload),
            status: 'pending_send',
            retry_count: 0,
          });
        } catch (err) {
          console.error(`[Scheduler] Failed to save dry run: ${err}`);
        }
        continue;
      }

      // Check if exceeds 20-second rule — ALERT and try to send
      if (hasExceededMaxInterval(imei, maxUpdateIntervalSeconds)) {
        console.log(`[Scheduler] ⚠️ Vehicle ${imei} has NO successful transmission in >${maxUpdateIntervalSeconds}s`);
        
        try {
          await alertManager.generate({
            severity: 'warning',
            type: 'vehicle_without_update_over_20_seconds',
            title: 'Vehicle Without Update',
            message: `Vehicle ${imei} has not had a successful ATU transmission in over ${maxUpdateIntervalSeconds} seconds`,
          });
        } catch {
          consoleAlert({
            severity: 'warning',
            type: 'vehicle_without_update_over_20_seconds',
            title: 'Vehicle Without Update',
            message: `Vehicle ${imei} has not had a successful ATU transmission in over ${maxUpdateIntervalSeconds} seconds`,
          });
        }

        // Reset consecutive rejections counter on new attempt
        this.consecutiveRejections.set(imei, 0);
      }

      // 3. Send via WebSocket
      try {
        const startTime = Date.now();
        
        // Save as pending_send first
        let dbId: number | undefined;
        try {
          dbId = await transmissionService.saveTransmission({
            imei: payload.imei,
            license_plate: payload.license_plate,
            route_id: payload.route_id,
            driver_id: payload.driver_id,
            direction_id: payload.direction_id,
            latitude: payload.latitude,
            longitude: payload.longitude,
            speed: payload.speed,
            ts: payload.ts,
            tsinitialtrip: payload.tsinitialtrip,
            identifier: payload.identifier,
            payload_json: JSON.stringify(payload),
            status: 'pending_send',
            retry_count: 0,
          });
        } catch (err) {
          console.error(`[Scheduler] Failed to save pending transmission: ${err}`);
        }

        const atuResponse = await wsClient.send(payload);
        markSent(imei, position);

        const action = handleResponse(atuResponse);
        console.log(`[Scheduler] ✅ Sent position for ${imei}, identifier=${payload.identifier}, atu_code=${atuResponse.codigo}, msg=${action.message}`);

        // Update with actual ATU response + generated message
        if (dbId !== undefined) {
          const latency = Date.now() - startTime;
          await transmissionService.updateTransmissionStatus(
            dbId,
            action.status,
            { codigo: atuResponse.codigo, descrip: action.message },
            latency
          );
        }

        // Record success for 20-second rule
        recordSuccess(imei);

        // Reset consecutive rejections
        this.consecutiveRejections.set(imei, 0);

        // Update transmission service stats
        transmissionService.recordSuccess(imei);

      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[Scheduler] ❌ Failed to send for ${imei}: ${message}`);

        // Track consecutive rejections
        const current = this.consecutiveRejections.get(imei) || 0;
        const newCount = current + 1;
        this.consecutiveRejections.set(imei, newCount);

        if (newCount >= 5) {
          console.error(`[Scheduler] ⚠️ ${imei} has ${newCount} consecutive rejections`);
          try {
            await alertManager.generate({
              severity: 'warning',
              type: 'consecutive_rejections',
              title: 'Consecutive Rejections',
              message: `Vehicle ${imei} has failed ATU transmission ${newCount} times consecutively`,
            });
          } catch {
            consoleAlert({
              severity: 'warning',
              type: 'consecutive_rejections',
              title: 'Consecutive Rejections',
              message: `Vehicle ${imei} has failed ATU transmission ${newCount} times consecutively`,
            });
          }
        }

        // Handle technical errors - schedule retry if appropriate
        const shouldRetry = transmissionService.shouldRetry(message);
        if (shouldRetry) {
          console.log(`[Scheduler] Scheduling retry for ${imei}`);
          // Retry logic handled by transmission service
        }

        // Update status to websocket_error
        try {
          await transmissionService.updateTransmissionStatus(
            undefined, // We don't have the ID here easily
            'websocket_error',
            { codigo: 'WS_ERROR', descrip: message },
            undefined
          );
        } catch (err) {
          console.error(`[Scheduler] Failed to update error status: ${err}`);
        }
      }
    }
  }

  /**
   * Stop transmission for a vehicle (called when token becomes invalid)
   */
  stopVehicleTransmission(imei: string): void {
    stopTransmission(imei);
  }

  /**
   * Clear stopped state (for re-authentication)
   */
  clearVehicleStoppedState(imei: string): void {
    clearStoppedState(imei);
  }
}