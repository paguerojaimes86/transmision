/**
 * Debug Routes — Inspect payloads without sending to ATU
 */

import { Router, Request, Response } from 'express';
import { config } from '../config/env';
import { MySqlGpsAdapter } from '../gps/adapters/mysql.adapter';
import { normalizeBatch } from '../gps/normalizer';
import { buildAtuPayload } from '../atu/mapper';
import { validatePayload } from '../atu/validator';
import { Pool } from 'mysql2/promise';

export function createDebugRoutes(pool: Pool): Router {
  const router = Router();

  /**
   * GET /debug/payload-sample
   * Returns the first GPS position converted to ATU payload format
   * WITHOUT sending it to ATU. Useful for inspecting the JSON structure.
   */
  router.get('/payload-sample', async (_req: Request, res: Response) => {
    try {
      const adapter = new MySqlGpsAdapter(pool);
      const rawRows = await adapter.getLatestPositions();

      if (rawRows.length === 0) {
        res.status(404).json({
          error: 'No GPS positions found in database',
          hint: 'Check that vehicles have active trips today and positions in tc_last_positions',
        });
        return;
      }

      const positions = normalizeBatch(rawRows);
      const firstPosition = positions[0];
      const payload = buildAtuPayload(firstPosition);
      const validation = validatePayload(payload);

      res.json({
        source: 'MySQL → Normalizer → Mapper → Validator',
        rawRow: rawRows[0],
        normalizedPosition: firstPosition,
        atuPayload: payload,
        validation,
        jsonString: JSON.stringify(payload, null, 2),
        totalVehicles: rawRows.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to build sample payload: ${message}` });
    }
  });

  /**
   * GET /debug/payloads-all
   * Returns ALL GPS positions as ATU payloads
   * WITHOUT sending them to ATU.
   */
  router.get('/payloads-all', async (_req: Request, res: Response) => {
    try {
      const adapter = new MySqlGpsAdapter(pool);
      const rawRows = await adapter.getLatestPositions();

      if (rawRows.length === 0) {
        res.status(404).json({
          error: 'No GPS positions found',
        });
        return;
      }

      const positions = normalizeBatch(rawRows);
      const payloads = positions.map((pos) => {
        const payload = buildAtuPayload(pos);
        const validation = validatePayload(payload);
        return {
          imei: payload.imei,
          plate: payload.license_plate,
          payload,
          valid: validation.valid,
          errors: validation.errors,
        };
      });

      const validCount = payloads.filter((p) => p.valid).length;
      const invalidCount = payloads.length - validCount;

      res.json({
        total: payloads.length,
        valid: validCount,
        invalid: invalidCount,
        payloads,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Failed to build payloads: ${message}` });
    }
  });

  /**
   * GET /debug/config
   * Returns current config (with sensitive values masked)
   */
  router.get('/config', (_req: Request, res: Response) => {
    res.json({
      atu: {
        wsEndpoint: config.ws.endpoint,
        maxUpdateIntervalSeconds: config.ws.maxUpdateIntervalSeconds,
        maxRetries: config.ws.maxRetries,
        reconnectSeconds: config.ws.reconnectSeconds,
      },
      gps: {
        sourceType: config.gps.sourceType,
        pollIntervalMs: config.gps.pollIntervalMs,
        speedUnit: config.gps.speedUnit,
      },
      route: config.route,
      position: config.position,
      dryRun: config.dryRun,
      env: config.env,
    });
  });

  return router;
}
