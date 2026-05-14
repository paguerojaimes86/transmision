/**
 * Transmission Routes
 * Endpoints for transmission history and retrieval
 */

import { Router, Request, Response } from 'express';
import { TransmissionRepository, TransmissionRecord, TransmissionStatus } from '../transmissions/repository';

interface PaginationQuery {
  status?: TransmissionStatus;
  imei?: string;
  limit?: string;
  offset?: string;
}

export function createTransmissionRoutes(repository: TransmissionRepository): Router {
  const router = Router();

  /**
   * GET /atu/transmissions — Paginated list of transmissions
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const query = req.query as PaginationQuery;
      const limit = parseInt(query.limit ?? '50', 10);
      const offset = parseInt(query.offset ?? '0', 10);
      const status = query.status as TransmissionStatus | undefined;
      const imei = query.imei || undefined;

      const result = await repository.getPaginated({ status, imei, limit, offset });

      res.json({
        records: result.records,
        total: result.total,
        limit,
        offset,
        hasMore: offset + result.records.length < result.total,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get transmissions: ${message}` });
    }
  });

  /**
   * GET /atu/transmissions/latest — Recent transmissions
   */
  router.get('/latest', async (req: Request, res: Response) => {
    try {
      const query = req.query as { limit?: string };
      const limit = parseInt(query.limit ?? '50', 10);

      const records = await repository.getRecent(limit);

      res.json({
        records,
        count: records.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get latest transmissions: ${message}` });
    }
  });

  /**
   * GET /atu/transmissions/errors — Rejected/failed transmissions only
   */
  router.get('/errors', async (req: Request, res: Response) => {
    try {
      const query = req.query as { limit?: string; status?: string };
      const limit = parseInt(query.limit ?? '50', 10);

      // Get rejected and failed statuses
      const records = await repository.getByStatus('rejected_by_atu', limit);

      // Also get token errors
      const tokenErrors = await repository.getByStatus('token_error', limit);

      // And websocket errors
      const wsErrors = await repository.getByStatus('websocket_error', limit);

      // Combine and dedupe by ID
      const allErrors = [...records];
      const existingIds = new Set(allErrors.map(r => (r as any).id));

      for (const e of tokenErrors) {
        if (!existingIds.has((e as any).id)) {
          allErrors.push(e);
          existingIds.add((e as any).id);
        }
      }
      for (const e of wsErrors) {
        if (!existingIds.has((e as any).id)) {
          allErrors.push(e);
          existingIds.add((e as any).id);
        }
      }

      res.json({
        records: allErrors.slice(0, limit),
        count: allErrors.length,
        statuses: ['rejected_by_atu', 'token_error', 'websocket_error'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get error transmissions: ${message}` });
    }
  });

  /**
   * GET /atu/transmissions/live — Ultimas transmisiones con payload para panel en tiempo real
   */
  router.get('/live', async (req: Request, res: Response) => {
    try {
      const query = req.query as { limit?: string };
      const limit = parseInt(query.limit ?? '30', 10);

      const records = await repository.getRecent(limit);

      const liveData = records
        .filter((r) => r.payload_json)
        .map((r) => {
          let payload: any = null;
          try {
            payload = JSON.parse(r.payload_json);
          } catch {
            payload = r.payload_json;
          }

          const toHuman = (ms: number) => {
            const d = new Date(ms);
            return d.toLocaleString('es-PE', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              timeZone: 'America/Lima',
            });
          };

          return {
            id: r.id,
            imei: r.imei,
            placa: r.license_plate,
            ruta: r.route_id,
            direccion: r.direction_id === 0 ? 'IDA' : 'VUELTA',
            conductor: r.driver_id,
            velocidad: r.speed,
            latitud: r.latitude,
            longitud: r.longitude,
            ts: r.ts,
            ts_humano: r.ts ? toHuman(r.ts) : null,
            tsinitialtrip: r.tsinitialtrip,
            tsinitialtrip_humano: r.tsinitialtrip ? toHuman(r.tsinitialtrip) : null,
            codigo_atu: r.atu_response_code,
            latencia_ms: r.latency_ms,
            identifier: r.identifier,
            created_at: r.created_at,
            payload_json: payload,
          };
        });

      res.json({
        records: liveData,
        count: liveData.length,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get live transmissions: ${message}` });
    }
  });

  /**
   * GET /atu/transmissions/vehicles — List of distinct vehicles with transmissions
   */
  router.get('/vehicles', async (_req: Request, res: Response) => {
    try {
      const vehicles = await repository.getDistinctVehicles();
      res.json({ vehicles, count: vehicles.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get vehicles: ${message}` });
    }
  });

  /**
   * GET /atu/transmissions/:id — Single transmission by ID
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);

      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid transmission ID' });
        return;
      }

      const record = await repository.getById(id);

      if (!record) {
        res.status(404).json({ error: 'Transmission not found' });
        return;
      }

      res.json(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get transmission: ${message}` });
    }
  });

  /**
   * GET /atu/transmissions/by-imei/:imei — Transmissions for specific vehicle
   */
  router.get('/by-imei/:imei', async (req: Request, res: Response) => {
    try {
      const imei = req.params.imei;
      const query = req.query as { limit?: string };
      const limit = parseInt(query.limit ?? '50', 10);

      const records = await repository.getLatestByImei(imei, limit);

      res.json({
        imei,
        records,
        count: records.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to get transmissions for IMEI: ${message}` });
    }
  });

  return router;
}