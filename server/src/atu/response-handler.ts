/**
 * ATU Response Handler
 * Parses ATU responses and routes to appropriate action
 */

import { TransmissionStatus } from './ws-client';

/**
 * ATU Response shape from the WebSocket server
 * NOTE: ATU returns fields with capitalized first letter:
 *   Codigo, Identifier, Timestamp
 * We normalize to lowercase for internal use.
 */
export interface AtuResponse {
  codigo: string;      // '00', '01', '03', '05'...'14', '16', '17'
  identifier?: string; // ATU returns "Identifier" with capital I
  timestamp?: string;  // ATU returns "Timestamp" with capital T
  descrip?: string;   // description (ATU may include this)
}

/**
 * ATU Code definitions and their actions
 */
export const ATU_CODES = {
  '00': { action: 'ACCEPTED', retry: false, stop: false },
  '01': { action: 'FORMAT_ERROR', retry: false, stop: false },
  '03': { action: 'INVALID_TOKEN', retry: false, stop: true },
  '05': { action: 'IDENTIFIER_EMPTY', retry: false, stop: false },
  '06': { action: 'IMEI_INVALID', retry: false, stop: false },
  '07': { action: 'PLATE_INVALID', retry: false, stop: false },
  '08': { action: 'COORDINATES_INVALID', retry: false, stop: false },
  '09': { action: 'SPEED_INVALID', retry: false, stop: false },
  '10': { action: 'OPERATOR_INVALID', retry: false, stop: false },
  '11': { action: 'IDENTIFIER_INVALID', retry: false, stop: false },
  '12': { action: 'ROUTE_ID_INVALID', retry: false, stop: false },
  '13': { action: 'DIRECTION_ID_INVALID', retry: false, stop: false },
  '14': { action: 'DRIVER_ID_INVALID', retry: false, stop: false },
} as const;

export type AtuCode = keyof typeof ATU_CODES;

/**
 * Action to take based on ATU response code
 */
export interface ResponseAction {
  status: TransmissionStatus;
  code: string;
  message: string;
  shouldStop: boolean;
  shouldRetry: boolean;
}

/**
 * Human-readable messages for each ATU code
 */
export const ATU_CODE_MESSAGES: Record<string, string> = {
  '00': 'Position accepted by ATU',
  '01': 'Format error in payload',
  '03': 'Invalid authentication token',
  '05': 'Identifier field is empty',
  '06': 'IMEI is invalid (must be 15 alphanumeric characters)',
  '07': 'License plate is invalid (must be 1-7 alphanumeric characters)',
  '08': 'Coordinates are invalid (latitude/longitude out of range)',
  '09': 'Speed is invalid (must be 0-999.99 km/h)',
  '10': 'Operator data is invalid',
  '11': 'Identifier is invalid (must be 1-50 alphanumeric characters)',
  '12': 'Route ID is invalid (must be 1-10 alphanumeric characters)',
  '13': 'Direction ID is invalid (must be 0 or 1)',
  '14': 'Driver ID is invalid (must be 1-20 alphanumeric characters)',
};

/**
 * Get the human-readable message for an ATU code
 */
export function getAtuCodeMessage(code: string): string {
  return ATU_CODE_MESSAGES[code] ?? `Unknown ATU code: ${code}`;
}

/**
 * Handle an ATU response and determine the appropriate action
 */
export function handleResponse(response: AtuResponse): ResponseAction {
  const code = response.codigo;
  const codeInfo = ATU_CODES[code as AtuCode];

  if (!codeInfo) {
    return {
      status: 'rejected_by_atu',
      code,
      message: `Unknown ATU response code: ${code}`,
      shouldStop: false,
      shouldRetry: false,
    };
  }

  let status: TransmissionStatus;
  if (code === '00') {
    status = 'accepted_by_atu';
  } else if (code === '03') {
    status = 'token_error';
  } else {
    status = 'rejected_by_atu';
  }

  const description = response.descrip ?? getAtuCodeMessage(code);

  return {
    status,
    code,
    message: description,
    shouldStop: codeInfo.stop,
    shouldRetry: codeInfo.retry,
  };
}
