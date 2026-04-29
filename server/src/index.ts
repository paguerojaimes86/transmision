/**
 * ATU GPS Forwarder — Express Entry Point
 * Main application initialization and routing
 */

import 'dotenv/config';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { Pool } from 'mysql2/promise';

import { config } from './config/env';
import { createAtuWsClient, AtuWsClient } from './atu/ws-client';
import { TransmissionScheduler } from './atu/scheduler';
import { TransmissionService } from './transmissions/transmission-service';
import { TransmissionRepository } from './transmissions/repository';
import { GpsSourceAdapter } from './gps/adapters/gps-source.adapter';
import { MySqlGpsAdapter } from './gps/adapters/mysql.adapter';
import { normalize, normalizeBatch } from './gps/normalizer';
import { buildAtuPayload, AtuPayload } from './atu/mapper';
import { validatePayload, isOlderThanTenMinutes } from './atu/validator';
import { handleResponse, AtuResponse as HandlerAtuResponse } from './atu/response-handler';
import { AlertManager, consoleAlert } from './alerts/alert-manager';
import { RetryManager } from './atu/retry';
import { HealthService } from './health/health.service';

// Route imports
import { createHealthRoutes } from './api/health.routes';
import { createAtuRoutes } from './api/atu.routes';
import { createTransmissionRoutes } from './api/transmissions.routes';
import { createReportsRoutes } from './api/reports.routes';
import { createGpsRoutes } from './api/gps.routes';
import { createAuthRoutes } from './api/auth.routes';
import { createDebugRoutes } from './api/debug.routes';
import { authMiddleware } from './middleware/auth';

/**
 * Check if required database tables exist
 */
async function checkTablesExist(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1 FROM atu_transmissions LIMIT 1');
    return true;
  } catch {
    console.warn('atu_transmissions table not found. Run SQL scripts first.');
    return false;
  }
}

/**
 * Graceful shutdown handler
 */
function setupGracefulShutdown(options: {
  wsClient: AtuWsClient;
  pool: Pool;
  scheduler: TransmissionScheduler;
}): void {
  const { wsClient, pool, scheduler } = options;

  const shutdown = async (signal: string) => {
    console.log(`\n[Server] ${signal} received, shutting down gracefully...`);

    // Stop scheduler
    scheduler.stop();
    console.log('[Server] Scheduler stopped');

    // Disconnect WebSocket
    wsClient.disconnect();
    console.log('[Server] WebSocket disconnected');

    // Close MySQL pool
    await pool.end();
    console.log('[Server] MySQL pool closed');

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Main application setup
 */
async function main(): Promise<void> {
  console.log('[Server] Starting ATU GPS Forwarder...');
  console.log(`[Server] Environment: ${config.env}`);

  // Initialize MySQL connection pool
  const pool: Pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  console.log('[Server] MySQL pool created');

  // Check table existence (warning only - user handles DDL)
  const tablesExist = await checkTablesExist(pool);
  if (!tablesExist) {
    console.warn('[Server] WARNING: Database tables not ready. Start may have errors.');
  }

// Initialize GPS adapter
  const gpsAdapter: GpsSourceAdapter = new MySqlGpsAdapter(pool);
  console.log('[Server] GPS adapter initialized');

  // Initialize core services
  const alertManager = new AlertManager(pool);
  const retryManager = new RetryManager();

  // Initialize repository
  const repository = new TransmissionRepository(pool);

  // Initialize ATU WebSocket client
  const wsClient = createAtuWsClient({
    onMessage: () => { /* handled by transmission service */ },
    onDisconnect: () => { /* handled by transmission service */ },
    onTokenInvalid: () => { /* handled by transmission service */ },
  });

  // Initialize transmission service
  const transmissionService = new TransmissionService({
    gpsAdapter,
    normalizer: normalize,
    mapper: buildAtuPayload,
    validator: validatePayload,
    wsClient,
    responseHandler: handleResponse,
    repository,
    alertManager,
    retryManager,
    config,
  });

  // Initialize scheduler
  const scheduler = new TransmissionScheduler({
    gpsAdapter,
    normalizer: normalize,
    mapper: buildAtuPayload,
    validator: validatePayload,
    wsClient,
    transmissionService,
    alertManager,
    dryRun: config.dryRun,
    maxUpdateIntervalSeconds: config.ws.maxUpdateIntervalSeconds,
    maxPositionAgeMinutes: config.position.maxAgeMinutes,
  });

  // Initialize health service
  const healthService = new HealthService({
    pool,
    wsClient,
    gpsAdapter,
  });

  // Create Express app
  const app: Express = express();

  // Middleware
  app.use(cors({
    origin: '*', // Configure as needed for production
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[HTTP] ${req.method} ${req.path}`);
    next();
  });

  // Public routes (no auth required)
  app.use('/auth', createAuthRoutes());
  app.use('/health', createHealthRoutes(healthService));

  // Auth middleware for protected routes
  app.use(authMiddleware);

  // Protected routes
  app.use('/atu', createAtuRoutes({
    transmissionService,
    repository,
    scheduler,
    wsClient,
  }));

  // Register transmission routes
  app.use('/atu/transmissions', createTransmissionRoutes(repository));

  // Register reports routes
  app.use('/reports', createReportsRoutes({
    repository,
    gpsAdapter,
  }));

  // Register GPS routes
  app.use('/gps', createGpsRoutes({ gpsAdapter }));

  // Register debug routes
  app.use('/debug', createDebugRoutes(pool));

  // Root endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'ATU GPS Forwarder',
      version: '1.0.0',
      status: 'running',
      environment: config.env,
      endpoints: {
        health: '/health',
        auth: '/auth',
        atu: '/atu',
        transmissions: '/atu/transmissions',
        reports: '/reports',
        gps: '/gps',
        debug: '/debug',
      },
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start server
  const port = config.app.port;
  const server = app.listen(port, () => {
    console.log(`[Server] HTTP server listening on port ${port}`);
  });

  // Connect WebSocket to ATU
  console.log('[Server] Connecting to ATU WebSocket...');
  wsClient.connect().then(() => {
    console.log('[Server] ATU WebSocket connected');
  }).catch((err) => {
    console.error('[Server] Failed to connect to ATU WebSocket:', err.message);
  });

  // Auto-start transmission scheduler
  if (!config.dryRun) {
    console.log('[Server] Auto-starting transmission scheduler...');
    scheduler.start();
  } else {
    console.log('[Server] Dry-run mode - scheduler not auto-started');
  }

  // Setup graceful shutdown
  setupGracefulShutdown({
    wsClient,
    pool,
    scheduler,
  });

  console.log('[Server] Initialization complete');
}

main().catch((err) => {
  console.error('[Server] Fatal error during startup:', err);
  process.exit(1);
});
