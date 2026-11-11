import api from './api';
import { QueueMessage, RedisListener } from './redisListener';
import { EncorePackager } from './encorePackager';
import { Config } from './config';
import { PackageListener } from './packageListener';
import logger from './logger';
import {
  createCallbackListener,
  createJobCallbackListener
} from './callbackListener';

async function loadPackageListener(
  pluginPath: string | undefined
): Promise<PackageListener | undefined> {
  if (!pluginPath) {
    return undefined;
  }

  try {
    const module = await import(pluginPath);
    return module as PackageListener;
  } catch (err) {
    logger.error(
      `Failed to load notifications module from ${pluginPath}: ${
        (err as Error)?.message
      }`
    );
  }
  return undefined;
}

export async function startListener(config: Config) {
  const pluginListener = await loadPackageListener(
    config.packaging.packageListenerPlugin
  );

  const packageListener =
    pluginListener ??
    createCallbackListener(config.callback, config.packaging.oscAccessToken);

  // A job may carry its own callbackUrl, which is used for that job instead of
  // the configured CALLBACK_URL. A job without one keeps the configured
  // callback. A listener plugin stays in charge of every job, as before, since
  // it can do work a callback cannot replace.
  const packageListenerFor = (message: QueueMessage) => {
    if (!message.callbackUrl) {
      return undefined;
    }
    if (pluginListener) {
      logger.warn(
        `Ignoring callbackUrl on job ${message.jobId}: a package listener plugin is configured for this instance`
      );
      return undefined;
    }
    return createJobCallbackListener(
      message.callbackUrl,
      config.packaging.oscAccessToken
    );
  };

  const encorePackager = new EncorePackager(config.packaging);
  logger.info('Starting redis listener');
  const redisListener = new RedisListener(
    config.redis,
    (message) => {
      if (config.packaging.skipPackaging) {
        return encorePackager.copyAndGenerateSmil(
          message.url,
          message.encryption
        );
      } else {
        return encorePackager.package(message.url, message.encryption);
      }
    },
    config.packaging.concurrency,
    packageListener,
    packageListenerFor
  );
  redisListener.start();

  if (!config.healthcheck.disabled) {
    logger.info(
      `Starting healthcheck endpoint on ${config.healthcheck.host}:${config.healthcheck.port}`
    );
    const server = api({
      redisStatus: () => redisListener.redisStatus(),
      retryJob: (message) => redisListener.retryJob(message),
      title: 'Encore Packager API',
      description: 'API for managing packaging jobs and health checks'
    });
    server.listen(
      { port: config.healthcheck.port, host: config.healthcheck.host },
      (err, address) => {
        if (err) {
          throw err;
        }
        logger.info(`Server listening on ${address}`);
      }
    );
  }
}
