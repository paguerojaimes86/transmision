/**
 * Transmissions Page
 * Full transmission history with filtering, pagination, and CSV export
 */

import { useState, useEffect } from 'react';
import { api, TransmissionRecord } from '../api/client';

type StatusFilter = 'all' | 'accepted' | 'rejected' | 'validation_failed' | 'expired';

interface TransmissionResponse {
  records: TransmissionRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

function Transmissions() {
  const [data, setData] = useState<TransmissionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedRecord, setSelectedRecord] = useState<TransmissionRecord | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const pageSize = 50;

  const fetchTransmissions = async () => {
    try {
      setError(null);
      let status: string | undefined;

      if (statusFilter !== 'all') {
        const statusMap = {
          accepted: 'accepted_by_atu',
          rejected: 'rejected_by_atu',
          validation_failed: 'validation_failed',
          expired: 'expired',
        } as const;
        status = statusMap[statusFilter as keyof typeof statusMap];
      }

      const result = await api.getTransmissions({
        status,
        limit: pageSize,
        offset: currentPage * pageSize,
      });

      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las transmisiones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchTransmissions();
  }, [statusFilter, currentPage]);

  const formatTimestamp = (ts: string | null): string => {
    if (!ts) return '—';
    const date = new Date(ts);
    return date.toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatUnixMs = (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined) return '—';
    const date = new Date(ms);
    return date.toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
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
      websocket_error: 'WS ERROR',
    };
    return labels[status] || status.toUpperCase();
  };

  const exportToCSV = () => {
    if (!data?.records) return;

    const headers = ['ID', 'Placa', 'IMEI', 'Ruta', 'Status', 'Código ATU', 'Latencia (ms)', 'Timestamp', 'Identifier'];
    const rows = data.records.map((r) => [
      r.id,
      r.license_plate,
      r.imei,
      r.route_id,
      r.status,
      r.atu_response_code || '',
      r.latency_ms !== null ? r.latency_ms : '',
      r.created_at,
      r.identifier || '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transmissions_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  if (loading && !data) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <h2 className="page-title">Historial de transmisiones</h2>
        <p className="page-subtitle">Registro completo de todas las transmisiones ATU</p>
      </div>

      {/* Filter Bar */}
      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">Estado:</span>
          <select
            className="filter-select"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              setCurrentPage(0);
            }}
          >
            <option value="all">Todos</option>
            <option value="accepted">Aceptadas</option>
            <option value="rejected">Rechazadas</option>
            <option value="validation_failed">Validación fallida</option>
            <option value="expired">Expiradas</option>
          </select>
        </div>

        <div style={{ flex: 1 }} />

        <button className="export-btn" onClick={exportToCSV}>
          📥 Exportar CSV
        </button>
      </div>

      {/* Error State */}
      {error && (
        <div className="error-state mb-4">
          <p>{error}</p>
          <button className="btn btn-primary mt-4" onClick={fetchTransmissions}>
            Reintentar
          </button>
        </div>
      )}

      {/* Data Table */}
      <div className="panel">
        <div className="table-container">
          {loading ? (
            <div className="loading">
              <div className="loading-spinner" />
            </div>
          ) : data?.records.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📡</div>
              <p className="empty-state-title">No se encontraron transmisiones</p>
              <p className="empty-state-text">
                {statusFilter !== 'all'
                  ? `No hay transmisiones ${statusFilter} en la base de datos`
                  : 'Aún no hay transmisiones registradas'}
              </p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Placa</th>
                  <th>IMEI</th>
                  <th>Ruta</th>
                  <th>Estado</th>
                  <th>Código</th>
                  <th>Latencia</th>
                  <th>Timestamp</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data?.records.map((record) => (
                  <tr
                    key={record.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedRecord(record)}
                  >
                    <td>{record.id}</td>
                    <td style={{ fontWeight: 600 }}>{record.license_plate}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{record.imei}</td>
                    <td>{record.route_id}</td>
                    <td>
                      <span className={`status-pill ${getStatusClass(record.status)}`}>
                        {getStatusLabel(record.status)}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace' }}>
                      {record.atu_response_code || '—'}
                    </td>
                    <td>
                      {record.latency_ms !== null ? `${record.latency_ms}ms` : '—'}
                    </td>
                    <td className="timestamp">{formatTimestamp(record.created_at)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRecord(record);
                        }}
                      >
                        Detalles
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {data && data.total > pageSize && (
          <div className="pagination">
            <span className="pagination-info">
              Mostrando {currentPage * pageSize + 1} a{' '}
              {Math.min((currentPage + 1) * pageSize, data.total)} de {data.total}
            </span>
            <div className="pagination-controls">
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
              >
                ← Anterior
              </button>
              <span style={{ padding: '6px 12px', color: 'var(--text-secondary)' }}>
                Página {currentPage + 1} de {totalPages}
              </span>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => setCurrentPage((p) => p + 1)}
                disabled={!data.hasMore}
              >
                Siguiente →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Transmisión #{selectedRecord.id}</h3>
              <button className="modal-close" onClick={() => setSelectedRecord(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              {/* Detail Grid */}
              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Placa</span>
                  <span className="detail-value">{selectedRecord.license_plate}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">IMEI</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.imei}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Ruta</span>
                  <span className="detail-value">{selectedRecord.route_id}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Estado</span>
                  <span className={`status-pill ${getStatusClass(selectedRecord.status)}`}>
                    {getStatusLabel(selectedRecord.status)}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Código de respuesta ATU</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.atu_response_code || '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Mensaje de respuesta ATU</span>
                  <span className="detail-value">
                    {selectedRecord.atu_response_message || '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Latencia</span>
                  <span className="detail-value">
                    {selectedRecord.latency_ms !== null ? `${selectedRecord.latency_ms}ms` : '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Identifier</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.identifier || '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Driver ID</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.driver_id || '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Dirección</span>
                  <span className="detail-value">
                    {selectedRecord.direction_id === 0 ? 'IDA' : 'VUELTA'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Latitud</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.latitude ?? '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Longitud</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.longitude ?? '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Velocidad (km/h)</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.speed ?? '—'}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Timestamp GPS (ts)</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.ts ?? '—'}
                  </span>
                  <span className="detail-value" style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                    {selectedRecord.ts ? formatUnixMs(selectedRecord.ts) : ''}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Trip Start (tsinitialtrip)</span>
                  <span className="detail-value" style={{ fontFamily: 'monospace' }}>
                    {selectedRecord.tsinitialtrip ?? '—'}
                  </span>
                  <span className="detail-value" style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                    {selectedRecord.tsinitialtrip ? formatUnixMs(selectedRecord.tsinitialtrip) : ''}
                  </span>
                </div>
                <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                  <span className="detail-label">Timestamp</span>
                  <span className="detail-value">
                    {formatTimestamp(selectedRecord.created_at)}
                  </span>
                </div>
              </div>

              {/* Payload JSON */}
              {(() => {
                const rawPayload = selectedRecord.payload_json || selectedRecord.payload;
                if (!rawPayload) return null;

                let formattedPayload: string;
                try {
                  const parsed = JSON.parse(rawPayload);
                  formattedPayload = JSON.stringify(parsed, null, 2);
                } catch {
                  formattedPayload = rawPayload;
                }

                return (
                  <div style={{ marginTop: '16px' }}>
                    <h4 style={{ marginBottom: '8px', color: 'var(--text-secondary)' }}>
                      JSON enviado a ATU:
                    </h4>
                    <div className="payload-viewer">
                      {formattedPayload}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedRecord(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Transmissions;
