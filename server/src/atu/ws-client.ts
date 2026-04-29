/**
 * ATU WebSocket Client
 * Manages connection, reconnection, and message sending to ATU WebSocket
 */

import WebSocket from 'ws';
import { config } from '../config/env';
import { buildAtuWsUrl, maskToken } from '../config/atu.config';
import { AtuPayload } from './mapper';

export interface AtuResponse {
  codigo: string;
  identifier: string;
  timestamp: string;
  descrip?: string;
}

export type TransmissionStatus = 'accepted_by_atu' | 'rejected_by_atu' | 'token_error';

export interface AtuWsClientOptions {
  wsUrl: string;
  onMessage?: (response: AtuResponse) => void;
  onDisconnect?: () => void;
  onTokenInvalid?: () => void;
}

export class AtuWsClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private options: {
    onMessage: (response: AtuResponse) => void;
    onDisconnect: () => void;
    onTokenInvalid: () => void;
  };
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pendingMessages: Map<string, AtuPayload> = new Map();
  private _isConnected = false;

  constructor(options: AtuWsClientOptions) {
    this.wsUrl = options.wsUrl;
    // Wrap callbacks to handle optional handlers and avoid null reference
    this.options = {
      onMessage: options.onMessage ?? (() => {}),
      onDisconnect: options.onDisconnect ?? (() => {}),
      onTokenInvalid: options.onTokenInvalid ?? (() => {}),
    };
  }

  /**
   * Connect to ATU WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log(`[ATU WS] Connecting to ${this.wsUrl.replace(/token=[^&]*/, 'token=****')}`);

        this.ws = new WebSocket(this.wsUrl);

        // Set connection timeout
        const connectionTimeout = setTimeout(() => {
          if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
            this.ws.terminate();
            reject(new Error('Connection timeout'));
          }
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          this._isConnected = true;
          this.reconnectAttempts = 0;
          console.log('[ATU WS] Connected successfully');
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const response = JSON.parse(data.toString()) as AtuResponse;
            console.log(`[ATU WS] Received response: codigo=${response.codigo}, identifier=${response.identifier}`);

            // Check if it's a token invalid response
            if (response.codigo === '03') {
              console.error('[ATU WS] Token invalid - received code 03 from ATU');
              this.options.onTokenInvalid();
              return;
            }

            this.options.onMessage(response);
          } catch (error) {
            console.error('[ATU WS] Failed to parse response:', error);
          }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[ATU WS] Connection closed: code=${code}, reason=${reason.toString()}`);
          this._isConnected = false;
          this.stopHeartbeat();
          this.options.onDisconnect();
          this.scheduleReconnect();
        });

        this.ws.on('error', (error: Error) => {
          console.error(`[ATU WS] Error: ${error.message}`);
          // Don't reject on error - let reconnect handle it
        });

      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        reject(new Error(`Failed to connect to ATU WebSocket: ${message}`));
      }
    });
  }

  /**
   * Send a payload and wait for response
   */
  async send(payload: AtuPayload): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    return new Promise((resolve, reject) => {
      const messageId = payload.identifier;
      this.pendingMessages.set(messageId, payload);

      const timeout = setTimeout(() => {
        this.pendingMessages.delete(messageId);
        reject(new Error(`Timeout waiting for ATU response for identifier: ${messageId}`));
      }, 30000); // 30s timeout

      // Store timeout reference for cleanup
      const timeoutRef = { timeout, cleared: false };
      const originalOnMessage = this.options.onMessage;

      // Wrap the onMessage to handle this specific message
      this.options.onMessage = (response: AtuResponse) => {
        if (response.identifier === messageId) {
          if (!timeoutRef.cleared) {
            clearTimeout(timeoutRef.timeout);
            timeoutRef.cleared = true;
          }
          this.pendingMessages.delete(messageId);
          // Restore original handler after first response
          setTimeout(() => {
            this.options.onMessage = originalOnMessage;
          }, 0);
          resolve();
        } else {
          // Pass through to original handler
          originalOnMessage(response);
        }
      };

      try {
        const jsonPayload = JSON.stringify(payload);
        console.log(`[ATU WS] Sending payload: identifier=${payload.identifier}`);
        console.log(`[ATU WS] JSON payload: ${jsonPayload}`);
        this.ws!.send(jsonPayload);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMessages.delete(messageId);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this._isConnected = false;
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    console.log('[ATU WS] Disconnected');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Attach event handlers (allows setting up callbacks after construction)
   */
  on(event: 'message', handler: (response: AtuResponse) => void): void;
  on(event: 'disconnect', handler: () => void): void;
  on(event: 'tokenInvalid', handler: () => void): void;
  on(event: string, handler: (...args: any[]) => void): void {
    if (event === 'message') {
      this.options.onMessage = handler;
    } else if (event === 'disconnect') {
      this.options.onDisconnect = handler;
    } else if (event === 'tokenInvalid') {
      this.options.onTokenInvalid = handler;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    // Don't reconnect if token was invalid
    if (this.reconnectAttempts >= config.ws.maxRetries) {
      console.error(`[ATU WS] Max retries (${config.ws.maxRetries}) reached. Stopping reconnection.`);
      return;
    }

    // Calculate delay with exponential backoff: 5s → 10s → 20s → 40s → 80s
    const delayMs = config.ws.reconnectSeconds * 1000 * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(`[ATU WS] Scheduling reconnect in ${delayMs / 1000}s (attempt ${this.reconnectAttempts}/${config.ws.maxRetries})`);

    this.reconnectTimeout = setTimeout(() => {
      console.log(`[ATU WS] Attempting reconnect #${this.reconnectAttempts}`);
      this.connect().catch((error) => {
        console.error(`[ATU WS] Reconnect failed: ${error.message}`);
        // scheduleReconnect is called again from the close event handler
      });
    }, delayMs);
  }

  /**
   * Start heartbeat ping
   */
  private startHeartbeat(): void {
    // Send ping every 30 seconds if configured
    const pingIntervalMs = 30 * 1000;

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
          console.log('[ATU WS] Heartbeat ping sent');
        } catch (error) {
          console.error('[ATU WS] Failed to send ping:', error);
        }
      }
    }, pingIntervalMs);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

/**
 * Create an ATU WebSocket client with config
 */
export function createAtuWsClient(options: Omit<AtuWsClientOptions, 'wsUrl'>): AtuWsClient {
  const wsUrl = buildAtuWsUrl();
  return new AtuWsClient({
    wsUrl,
    ...options,
  });
}
