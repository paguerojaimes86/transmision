/**
 * Transmission Service
 * Orchestrates the full transmission lifecycle to ATU
 */

import { config } from '../config/env';
import { GpsSourceAdapter } from '../gps/adapters/gps-source.adapter';
import { normalize, normalizeBatch } from '../gps/normalizer';
import { buildAtuPayload, AtuPayload } from '../atu/mapper';
import { validatePayload, isOlderThanTenMinutes } from '../atu/validator';
import { AtuWsClient, AtuResponse } from '../atu/ws-client';
import { handleResponse, AtuResponse as HandlerAtuResponse } from '../atu/response-handler';
import { TransmissionRepository, TransmissionRecord, TransmissionStats, TransmissionStatus } from './repository';
import { AlertManager, ALERT_TYPES } from '../alerts/alert-manager';
import { RetryManager, ErrorType } from '../atu/retry';

// Re-export status type for convenience
export type { TransmissionStatus, TransmissionRecord, TransmissionStats };

export interface TransmissionServiceOptions {
  gpsAdapter: GpsSourceAdapter;
  normalizer: typeof normalize;
  mapper: typeof buildAtuPayload;
  validator: typeof validatePayload;
  wsClient: AtuWsClient;
  responseHandler: typeof handleResponse;
  repository: TransmissionRepository;
  alertManager: AlertManager;
  retryManager: RetryManager;
  config: typeof config;
}

/**
 * Re-export consoleAlert for scheduler use
 */
export { consoleAlert } from '../alerts/alert-manager';

export class TransmissionService {
  private options: TransmissionServiceOptions;
  private _isActive = false;
  private consecutiveRejections: Map<string, number> = new Map();

  constructor(options: TransmissionServiceOptions) {
    this.options = options;
    this.setupWsCallbacks();
  }

  /**
   * Setup WebSocket callbacks
   */
  private setupWsCallbacks(): void {
    const { wsClient, alertManager, repository, retryManager } = this.options;

    // Handle messages
    wsClient.on('message', async (response: AtuResponse) => {
      console.log(`[TransmissionService] Received ATU response: code=${response.codigo}, identifier=${response.identifier}`);

      try {
        // Defensive: ATU may not return identifier in some edge cases
        if (!response.identifier) {
          console.warn(`[TransmissionService] ATU response missing identifier. Code: ${response.codigo}. Skipping DB update.`);
          return;
        }

        // Find the transmission by identifier
        const transmission = await repository.getByIdentifier(response.identifier);
        if (!transmission) {
          console.warn(`[TransmissionService] No transmission found for identifier: ${response.identifier}`);
          return;
        }

        const action = handleResponse(response);

        // Calculate latency from identifier timestamp
        let latency: number | undefined;
        try {
          const payload = JSON.parse(transmission.payload_json);
          if (payload.ts) {
            latency = Date.now() - payload.ts;
          }
        } catch {
          // Ignore parse errors
        }

        // Update status in DB
        await repository.updateStatus(
          (transmission as any).id,
          action.status as TransmissionStatus,
          response,
          latency
        );

        // Handle stop conditions (e.g., token invalid)
        if (action.shouldStop && response.codigo === '03') {
          console.error('[TransmissionService] 🚨 Token invalid - stopping all transmissions');
          
          await alertManager.generate({
            severity: 'critical',
            type: ALERT_TYPES.INVALID_TOKEN,
            title: 'ATU Token Invalid',
            message: `Token is no longer valid. All transmissions stopped. ATU response: ${response.descrip || response.codigo}`,
          });
        }

        // Handle retry for technical errors
        if (action.shouldRetry) {
          retryManager.recordRetry(response.identifier);
          
          // Save with retry_pending status
          await repository.updateStatus(
            (transmission as any).id,
            'retry_pending',
            undefined,
            undefined
          );

          // Get transmission record for retry
          const updatedTransmission = await repository.getByIdentifier(response.identifier);
          if (updatedTransmission) {
            this.scheduleRetry(updatedTransmission);
          }
        }

        // Reset retry on success
        if (response.codigo === '00') {
          retryManager.resetRetry(response.identifier);
        }

      } catch (error) {
        console.error(`[TransmissionService] Error handling response: ${error}`);
      }
    });

    // Handle disconnect
    wsClient.on('disconnect', async () => {
      console.warn('[TransmissionService] WebSocket disconnected');
      
      try {
        await alertManager.generate({
          severity: 'warning',
          type: ALERT_TYPES.WEBSOCKET_DISCONNECTED,
          title: 'WebSocket Disconnected',
          message: 'ATU WebSocket connection was lost',
        });
      } catch {
        // MySQL might not be available yet
        console.warn('[TransmissionService] Could not generate disconnect alert');
      }
    });

    // Handle token invalid
    wsClient.on('tokenInvalid', async () => {
      console.error('[TransmissionService] 🚨 Token invalid callback triggered');
      
      try {
        await alertManager.generate({
          severity: 'critical',
          type: ALERT_TYPES.INVALID_TOKEN,
          title: 'ATU Token Invalid',
          message: 'Token has been rejected by ATU. Immediate attention required.',
        });
      } catch {
        console.warn('[TransmissionService] Could not generate token invalid alert');
      }
    });
  }

  /**
   * Schedule a retry for a failed transmission
   */
  private async scheduleRetry(transmission: TransmissionRecord): Promise<void> {
    const { retryManager, wsClient } = this.options;
    
    const status = retryManager.getStatus(transmission.identifier);
    
    if (status.hasExceededMaxRetries) {
      console.warn(`[TransmissionService] Max retries exceeded for ${transmission.identifier}`);
      return;
    }

    if (status.isRetryScheduled) {
      console.log(`[TransmissionService] Retry already scheduled for ${transmission.identifier}`);
      return;
    }

    // Wait for backoff delay
    const delayMs = retryManager.getRetryDelayMs(transmission.identifier);
    
    setTimeout(async () => {
      try {
        const payload = JSON.parse(transmission.payload_json) as AtuPayload;
        console.log(`[TransmissionService] Retrying transmission for ${transmission.identifier}`);
        await wsClient.send(payload);
        retryManager.recordRetry(transmission.identifier);
      } catch (error) {
        console.error(`[TransmissionService] Retry failed for ${transmission.identifier}: ${error}`);
      }
    }, delayMs);
  }

  /**
   * Process positions from GPS source
   * This is the main entry point called by the scheduler
   */
  async processPositions(): Promise<void> {
    // Implementation is in scheduler - this is for API compatibility
    console.log('[TransmissionService] processPositions called - should be called from scheduler');
  }

  /**
   * Save a transmission record
   */
  async saveTransmission(record: Omit<TransmissionRecord, 'id' | 'created_at'>): Promise<number> {
    const { repository } = this.options;
    return repository.save(record as TransmissionRecord);
  }

  /**
   * Update transmission status
   */
  async updateTransmissionStatus(
    id: number | undefined,
    status: TransmissionStatus,
    response?: Partial<AtuResponse>,
    latency?: number
  ): Promise<void> {
    if (id === undefined) return;
    const { repository } = this.options;
    await repository.updateStatus(id, status, response, latency);
  }

  /**
   * Get transmission statistics
   */
  async getStats(): Promise<TransmissionStats> {
    const { repository } = this.options;
    return repository.getStats();
  }

  /**
   * Get recent transmissions
   */
  async getRecentTransmissions(limit: number = 100): Promise<TransmissionRecord[]> {
    const { repository } = this.options;
    return repository.getRecent(limit);
  }

  /**
   * Get transmissions by IMEI
   */
  async getTransmissionsByImei(imei: string, limit: number = 10): Promise<TransmissionRecord[]> {
    const { repository } = this.options;
    return repository.getLatestByImei(imei, limit);
  }

  /**
   * Determine if an error should trigger a retry
   */
  shouldRetry(errorMessage: string): boolean {
    const { retryManager } = this.options;
    const errorType = retryManager.classifyError(errorMessage);
    return retryManager.shouldRetry(errorMessage, errorType);
  }

  /**
   * Record a success for stats
   */
  recordSuccess(imei: string): void {
    this.consecutiveRejections.delete(imei);
  }

  /**
   * Start transmission service
   */
  start(): void {
    this._isActive = true;
    console.log('[TransmissionService] Started');
  }

  /**
   * Stop transmission service
   */
  stop(): void {
    this._isActive = false;
    console.log('[TransmissionService] Stopped');
  }

  /**
   * Check if service is active
   */
  isActive(): boolean {
    return this._isActive;
  }
}