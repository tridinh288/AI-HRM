import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/client.js';
import { logger } from './shared/logger.js';

/**
 * Process entry point: start the HTTP server, and shut it down cleanly.
 *
 * Graceful shutdown matters in a container, where a deploy sends SIGTERM and
 * then kills the process a few seconds later. Without the handler below, any
 * request in flight is severed mid-response and any open transaction is left to
 * time out on the database. With it, the server stops accepting new connections,
 * lets current requests finish, and closes the pool.
 */
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, aiProvider: env.AI_PROVIDER },
    'HRM API listening',
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // If something hangs, exit anyway rather than being killed mid-write.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async (error) => {
    if (error) logger.error({ err: error }, 'Error while closing HTTP server');
    try {
      await closeDatabase();
    } catch (dbError) {
      logger.error({ err: dbError }, 'Error while closing database pool');
    }
    clearTimeout(forceExit);
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// An unhandled rejection leaves the process in an unknown state. Log it with the
// full reason and stop, rather than serving requests from a corrupted process.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException');
});
