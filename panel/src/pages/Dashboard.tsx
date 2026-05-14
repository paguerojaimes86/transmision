/**
 * Dashboard Page
 * Real-time ATU transmission status with metrics, recent transmissions, and alerts
 */

import { useState, useEffect } from 'react';
import { api, AtuStatus, TransmissionRecord, VehicleWithoutTransmission, AtuErrorReport } from '../api/client';

interface DashboardData {
  status: AtuStatus;
  recentTransmissions: TransmissionRecord[];
  vehiclesWithoutUpdate: VehicleWithoutTransmission[];
  errors: AtuErrorReport;
  avgLatency: number;
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [payloadSample, setPayloadSample] = useState<{
    jsonString: string;
    totalVehicles: number;
    validation: { valid: boolean; errors: Array<{ field: string; message: string }> };
  } | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const [livePayloads, setLivePayloads] = useState<Array<{
    id: number;
    imei: string;
    placa: string;
    ts: number;
    ts_humano: string | null;
    tsinitialtrip: number;
    tsinitialtrip_humano: string | null;
    direccion: string;
    velocidad: number;
    codigo_atu: string | null;
    identifier: string;
    payload_json: Record<string, unknown> | null;
  }>>([]);
  const [selectedLivePayload, setSelectedLivePayload] = useState<Record<string, unknown> | null>(null);

  const fetchLivePayloads = async () => {
    try {
      const result = await api.getLivePayloads(20);
      setLivePayloads(result.records);
    } catch {
      // Silencioso
    }
  };

  const fetchDashboardData = async () => {
    try {
      setError(null);
      const [status, latest, vehicles, errorsReport] = await Promise.all([
        api.getStatus(),
        api.getLatestTransmissions(10),
        api.getVehiclesWithoutTransmission(20),
        api.getAtuErrorsReport(),
      ]);

      // Calculate average latency from recent transmissions
      const latencies = latest.records
        .filter((t) => t.latency_ms !== null && t.latency_ms > 0)
        .map((t) => t.latency_ms as number);

      const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;

      setData({
        status,
        recentTransmissions: latest.records,
        vehiclesWithoutUpdate: vehicles.vehicles,
        errors: errorsReport,
        avgLatency,
      });
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los datos del panel');
    } finally {
      setLoading(false);
    }
  };

  const fetchPayloadSample = async () => {
    try {
      setPayloadLoading(true);
      const sample = await api.getPayloadSample();
      setPayloadSample({
        jsonString: sample.jsonString,
        totalVehicles: sample.totalVehicles,
        validation: sample.validation,
      });
      setShowPayload(true);
    } catch (err) {
      console.error('Error cargando payload sample:', err);
    } finally {
      setPayloadLoading(false);
    }
  };

  const downloadAllPayloads = async () => {
    try {
      const data = await api.getPayloadsAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `atu-payloads-${new Date().toISOString().slice(0, 19)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      console.error('Error descargando payloads:', err);
      alert(`Error al descargar payloads: ${message}`);
    }
  };

  useEffect(() => {
    fetchDashboardData();
    fetchLivePayloads();
    const interval = setInterval(() => {
      fetchDashboardData();
      fetchLivePayloads();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatTimestamp = (ts: string | null): string => {
    if (!ts) return '—';
    const date = new Date(ts);
    return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const getStatusClass = (status: string): string => {
    if (status === 'accepted_by_atu') return 'accepted';
    if (status === 'rejected_by_atu') return 'rejected';
    if (status === 'expired') return 'expired';
    if (status === 'validation_failed') return 'validation_failed';
    return 'pending';
  };

  const getStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      accepted_by_atu: 'ACEPTADO',
      rejected_by_atu: 'RECHAZADO',
      expired: 'EXPIRADO',
      validation_failed: 'VALIDACIÓN',
      pending: 'PENDIENTE',
      token_error: 'TOKEN',
      websocket_error: 'WEBSOCKET',
    };
    return labels[status] || status.toUpperCase();
  };

  const getLatencyClass = (ms: number | null): string => {
    if (ms === null) return '';
    if (ms < 500) return 'fast';
    if (ms < 1500) return 'medium';
    return 'slow';
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-state">
        <p>Error al cargar el panel: {error}</p>
        <button className="btn btn-primary mt-4" onClick={fetchDashboardData}>
          Reintentar
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { status, recentTransmissions, vehiclesWithoutUpdate, errors, avgLatency } = data;

  return (
    <div>
      {/* Page Header */}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2 className="page-title">Panel</h2>
          <p className="page-subtitle">Monitoreo en tiempo real de transmisiones ATU</p>
        </div>
        <div className="refresh-indicator">
          <span className="refresh-dot" />
          Última actualización: {formatTimestamp(lastRefresh.toISOString())}
        </div>
      </div>

      {/* Connection & Mode Badges */}
      <div className="flex gap-4 mb-6">
        <div className={`status-badge ${status.websocketConnected ? 'connected' : 'disconnected'}`}>
          {status.websocketConnected ? 'Conectado a ATU' : 'Desconectado'}
        </div>
        <div className={`status-badge ${status.mode}`}>
          {status.mode.toUpperCase()}
        </div>
      </div>

      {/* Metric Cards */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-card-header">
            <span className="metric-label">Enviadas</span>
            <span className="metric-icon">📤</span>
          </div>
          <div className="metric-value">{status.totalTransmissions.toLocaleString()}</div>
        </div>

        <div className="metric-card accepted">
          <div className="metric-card-header">
            <span className="metric-label">Aceptadas</span>
            <span className="metric-icon">✓</span>
          </div>
          <div className="metric-value">{status.acceptedCount.toLocaleString()}</div>
        </div>

        <div className="metric-card rejected">
          <div className="metric-card-header">
            <span className="metric-label">Rechazadas</span>
            <span className="metric-icon">✗</span>
          </div>
          <div className="metric-value">{status.rejectedCount.toLocaleString()}</div>
        </div>

        <div className="metric-card active">
          <div className="metric-card-header">
            <span className="metric-label">Vehículos activos</span>
            <span className="metric-icon">🚗</span>
          </div>
          <div className="metric-value">{status.vehiclesActive}</div>
        </div>
      </div>

      {/* Info Row: Latency, Last Transmission */}
      <div className="info-row">
        <div className="info-item">
          <span className="info-label">Latencia promedio</span>
          <span className={`info-value large ${getLatencyClass(avgLatency)}`}>
            {avgLatency > 0 ? `${avgLatency} ms` : '—'}
          </span>
        </div>

        <div className="info-item">
          <span className="info-label">Última transmisión</span>
          <span className="info-value">
            {formatTimestamp(status.lastTransmissionAt)}
          </span>
        </div>

        {status.lastAtuResponse && (
          <div className="info-item">
            <span className="info-label">Última respuesta ATU</span>
            <span className="info-value">
              Código: {status.lastAtuResponse.code}
            </span>
          </div>
        )}
      </div>

      {/* JSON Payload Inspector */}
      <div className="panel mb-6">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="panel-title">📦 JSON Payload enviado a ATU</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn btn-secondary"
              onClick={fetchPayloadSample}
              disabled={payloadLoading}
              style={{ fontSize: '0.8rem', padding: '6px 12px' }}
            >
              {payloadLoading ? 'Cargando...' : showPayload ? 'Refrescar' : 'Ver JSON'}
            </button>
            <button
              className="btn btn-primary"
              onClick={downloadAllPayloads}
              style={{ fontSize: '0.8rem', padding: '6px 12px' }}
            >
              ⬇ Descargar todos
            </button>
          </div>
        </div>
        <div className="panel-body">
          {!showPayload && (
            <div className="empty-state" style={{ padding: '16px' }}>
              <p className="empty-state-text">
                Hacé clic en <strong>"Ver JSON"</strong> para ver el payload que se envía a ATU, o en <strong>"Descargar todos"</strong> para bajar un JSON con todos los vehículos.
              </p>
            </div>
          )}
          {showPayload && payloadSample && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {payloadSample.totalVehicles} vehículos activos
                </span>
                <span className={`status-pill ${payloadSample.validation.valid ? 'accepted' : 'rejected'}`}>
                  {payloadSample.validation.valid ? '✓ Válido' : '✗ Con errores'}
                </span>
              </div>
              {!payloadSample.validation.valid && payloadSample.validation.errors.length > 0 && (
                <div style={{ marginBottom: '12px', padding: '8px', background: 'rgba(239,68,68,0.1)', borderRadius: '4px' }}>
                  <strong style={{ color: 'var(--accent-red)', fontSize: '0.8rem' }}>Errores de validación:</strong>
                  <ul style={{ margin: '4px 0 0 0', paddingLeft: '16px', fontSize: '0.75rem', color: 'var(--accent-red)' }}>
                    {payloadSample.validation.errors.map((e, i) => (
                      <li key={i}>{e.field}: {e.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              <pre
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  padding: '12px',
                  fontSize: '0.75rem',
                  fontFamily: 'Monaco, Menlo, monospace',
                  overflow: 'auto',
                  maxHeight: '400px',
                  color: 'var(--text-primary)',
                }}
              >
                {payloadSample.jsonString}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Vehicles Without Update */}
      {vehiclesWithoutUpdate.length > 0 && (
        <div className="panel mb-6">
          <div className="panel-header">
            <span className="panel-title">⚠️ Vehículos sin actualización &gt;20s</span>
            <span className="count-badge warning">{vehiclesWithoutUpdate.length}</span>
          </div>
          <div className="panel-body">
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {vehiclesWithoutUpdate.map((v) => (
                <li
                  key={v.imei}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--bg-secondary)',
                    borderRadius: '4px',
                  }}
                >
                  <span style={{ fontFamily: 'monospace' }}>{v.imei}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Último: {formatTimestamp(v.lastTransmissionAt)} (hace {v.gapSeconds}s)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Main Dashboard Grid */}
      <div className="dashboard-grid">
        {/* Recent Transmissions Table */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Últimas 10 transmisiones</span>
          </div>
          <div className="panel-scroll">
            {recentTransmissions.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📡</div>
                <p className="empty-state-title">Aún no hay transmisiones</p>
                <p className="empty-state-text">Las transmisiones aparecerán aquí cuando el sistema inicie</p>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Placa</th>
                    <th>IMEI</th>
                    <th>Ruta</th>
                    <th>Código</th>
                    <th>Latencia</th>
                    <th>Hora</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTransmissions.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 600 }}>{t.license_plate}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{t.imei}</td>
                      <td>{t.route_id}</td>
                      <td>
                        <span className={`status-pill ${getStatusClass(t.status)}`}>
                          {t.atu_response_code || getStatusLabel(t.status)}
                        </span>
                      </td>
                      <td>
                        <span className={`latency-value ${getLatencyClass(t.latency_ms)}`}>
                          {t.latency_ms !== null ? `${t.latency_ms}ms` : '—'}
                        </span>
                      </td>
                      <td className="timestamp">{formatTimestamp(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Active Alerts Panel */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">🚨 Alertas activas</span>
          </div>
          <div className="panel-body">
            {errors.errors.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px' }}>
                <div className="empty-state-icon">✨</div>
                <p className="empty-state-title">Sin alertas activas</p>
                <p className="empty-state-text">El sistema funciona con normalidad</p>
              </div>
            ) : (
              <div className="alert-list">
                {errors.errors.slice(0, 5).map((err, idx) => {
                  // Determine severity based on error code
                  let severity: 'info' | 'warning' | 'critical' = 'info';
                  const code = err.code.toLowerCase();
                  if (code.includes('timeout') || code.includes('connection')) {
                    severity = 'critical';
                  } else if (code.includes('invalid') || code.includes('expired')) {
                    severity = 'warning';
                  }

                  return (
                    <div key={idx} className={`alert-card ${severity}`}>
                      <div className="alert-header">
                        <span className="alert-type">{severity.toUpperCase()}</span>
                      </div>
                      <div className="alert-title">Código de error: {err.code}</div>
                      <div className="alert-message">{err.message}</div>
                      <div className="alert-meta">Cantidad: {err.count}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Live Payloads Panel */}
        <div className="panel mb-6">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="panel-title">🔴 EN VIVO — JSONs enviados a ATU</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {livePayloads.length} payloads • refresca cada 5s
            </span>
          </div>
          <div className="panel-body" style={{ maxHeight: '500px', overflow: 'auto' }}>
            {livePayloads.length === 0 ? (
              <div className="empty-state" style={{ padding: '16px' }}>
                <p className="empty-state-text">Esperando transmisiones...</p>
              </div>
            ) : (
              <table className="data-table" style={{ fontSize: '0.7rem' }}>
                <thead>
                  <tr>
                    <th>Placa</th>
                    <th>Dir</th>
                    <th>Vel</th>
                    <th>GPS Timestamp (ts)</th>
                    <th>Trip Start (tsinitialtrip)</th>
                    <th>ATU</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {livePayloads.map((p) => (
                    <tr key={p.id} style={{ cursor: 'pointer' }}
                      onClick={() => setSelectedLivePayload(p.payload_json)}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{p.placa}</td>
                      <td>{p.direccion}</td>
                      <td>{p.velocidad}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.65rem' }}>
                        <div>{p.ts}</div>
                        <div style={{ color: 'var(--text-muted)' }}>{p.ts_humano}</div>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.65rem' }}>
                        <div>{p.tsinitialtrip}</div>
                        <div style={{ color: p.tsinitialtrip_humano ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                          {p.tsinitialtrip_humano || '—'}
                        </div>
                      </td>
                      <td>
                        <span className={`status-pill ${p.codigo_atu === '00' ? 'accepted' : 'rejected'}`}
                          style={{ fontSize: '0.6rem', padding: '2px 6px' }}>
                          {p.codigo_atu || '—'}
                        </span>
                      </td>
                      <td>
                        <button className="btn btn-sm btn-secondary" style={{ fontSize: '0.6rem', padding: '2px 6px' }}
                          onClick={(e) => { e.stopPropagation(); setSelectedLivePayload(p.payload_json); }}>
                          JSON
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Live Payload JSON Modal */}
        {selectedLivePayload && (
          <div className="modal-overlay" onClick={() => setSelectedLivePayload(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
              <div className="modal-header">
                <h3 className="modal-title">📦 JSON enviado a ATU</h3>
                <button className="modal-close" onClick={() => setSelectedLivePayload(null)}>×</button>
              </div>
              <div className="modal-body">
                <pre style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  padding: '12px',
                  fontSize: '0.7rem',
                  fontFamily: 'Monaco, Menlo, monospace',
                  overflow: 'auto',
                  maxHeight: '60vh',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {JSON.stringify(selectedLivePayload, null, 2)}
                </pre>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setSelectedLivePayload(null)}>Cerrar</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export default Dashboard;
