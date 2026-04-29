/**
 * API Client for ATU GPS Forwarder Panel
 * Fetches data from the Express backend
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface AtuStatus {
  transmissionActive: boolean;
  mode: 'testing' | 'production';
  vehiclesActive: number;
  totalTransmissions: number;
  acceptedCount: number;
  rejectedCount: number;
  lastAtuResponse: {
    code: string;
    identifier: string;
    timestamp: string;
  } | null;
  lastTransmissionAt: string | null;
  websocketConnected: boolean;
}

interface TransmissionRecord {
  id: number;
  license_plate: string;
  imei: string;
  route_id: string;
  status: string;
  atu_response_code: string | null;
  atu_response_message: string | null;
  latency_ms: number | null;
  created_at: string;
  identifier: string | null;
  payload?: string;
}

interface PaginatedResponse<T> {
  records: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  components: {
    gpsSource: { status: string; message?: string; lastCheck?: string };
    atuWebsocket: { status: string; message?: string; lastCheck?: string };
    database: { status: string; message?: string; lastCheck?: string };
  };
}

interface AtuConfig {
  endpoint: string;
  token: string;
  maxUpdateIntervalSeconds: number;
  maxRetries: number;
  reconnectSeconds: number;
  position: { maxAgeMinutes: number };
  gps: {
    sourceType: string;
    pollIntervalMs: number;
    speedUnit: string;
  };
  dryRun: boolean;
  env: string;
}

interface VehicleWithoutTransmission {
  imei: string;
  lastTransmissionAt: string | null;
  gapSeconds: number | null;
  hasActivePosition: boolean;
}

interface ReportSummary {
  overview: {
    totalTransmissions: number;
    accepted: number;
    rejected: number;
    failed: number;
    activeVehicles: number;
    acceptanceRate: number;
  };
  today: { total: number; accepted: number; rejected: number };
  recentActivity: {
    count: number;
    lastTransmissionAt: string | null;
  };
  topErrors: Array<{ code: string; count: number }>;
  generatedAt: string;
}

interface AtuErrorReport {
  errors: Array<{ code: string; message: string; count: number }>;
  totalErrors: number;
  generatedAt: string;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('atu_panel_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { ...getAuthHeaders() },
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function post<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

// ATU Status & Control
export const api = {
  // GET /atu/status
  getStatus: () => get<AtuStatus>('/atu/status'),

  // GET /atu/transmissions/latest?limit=50
  getLatestTransmissions: (limit = 50) =>
    get<{ records: TransmissionRecord[]; count: number }>(
      `/atu/transmissions/latest?limit=${limit}`
    ),

  // GET /atu/transmissions/errors
  getTransmissionErrors: () =>
    get<{ records: TransmissionRecord[]; count: number }>(
      '/atu/transmissions/errors'
    ),

  // GET /atu/transmissions?status=...&limit=50&offset=0
  getTransmissions: (options: { status?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return get<PaginatedResponse<TransmissionRecord>>(
      `/atu/transmissions${query ? `?${query}` : ''}`
    );
  },

  // GET /atu/config
  getConfig: () => get<AtuConfig>('/atu/config'),

  // POST /atu/start
  startTransmission: () =>
    post<{ success: boolean; message: string }>('/atu/start'),

  // POST /atu/stop
  stopTransmission: () =>
    post<{ success: boolean; message: string }>('/atu/stop'),

  // POST /atu/config
  updateConfig: (body: { token?: string; endpoint?: string; dryRun?: boolean }) =>
    post<{ success: boolean; message: string; updatedFields: string[] }>('/atu/config', body),

  // GET /reports/vehicles-without-transmission
  getVehiclesWithoutTransmission: (thresholdSeconds = 20) =>
    get<{
      vehicles: VehicleWithoutTransmission[];
      count: number;
      thresholdSeconds: number;
      generatedAt: string;
    }>(`/reports/vehicles-without-transmission?thresholdSeconds=${thresholdSeconds}`),

  // GET /health
  getHealth: () => get<HealthStatus>('/health'),

  // GET /health/atu-websocket
  getAtuWebsocketHealth: () =>
    get<{ status: string; message?: string; lastCheck?: string }>(
      '/health/atu-websocket'
    ),

  // GET /reports/atu-transmissions
  getAtuTransmissionsReport: (days = 7) =>
    get<{
      report: Array<{
        date: string;
        accepted: number;
        rejected: number;
        expired: number;
        failed: number;
        total: number;
      }>;
      days: number;
      generatedAt: string;
    }>(`/reports/atu-transmissions?days=${days}`),

  // GET /reports/atu-errors
  getAtuErrorsReport: () => get<AtuErrorReport>('/reports/atu-errors'),

  // GET /reports/summary
  getSummary: () => get<ReportSummary>('/reports/summary'),

  // GET /debug/payload-sample
  getPayloadSample: () => get<{
    source: string;
    rawRow: Record<string, unknown>;
    normalizedPosition: Record<string, unknown>;
    atuPayload: Record<string, unknown>;
    validation: { valid: boolean; errors: Array<{ field: string; message: string }> };
    jsonString: string;
    totalVehicles: number;
  }>('/debug/payload-sample'),

  // GET /debug/payloads-all
  getPayloadsAll: () => get<{
    total: number;
    valid: number;
    invalid: number;
    payloads: Array<{
      imei: string;
      plate: string;
      payload: Record<string, unknown>;
      valid: boolean;
      errors: Array<{ field: string; message: string }>;
    }>;
  }>('/debug/payloads-all'),
};

export type {
  AtuStatus,
  TransmissionRecord,
  HealthStatus,
  AtuConfig,
  VehicleWithoutTransmission,
  ReportSummary,
  AtuErrorReport,
};