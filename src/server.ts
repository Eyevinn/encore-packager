import api from './api';
import { RedisListener } from './redisListener';
import { EncorePackager } from './encorePackager';
import { Config } from './config';
import { PackageListener } from './packageListener';
import logger from './logger';

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
  const packageListener = await loadPackageListener(
    config.packaging.packageListenerPlugin
  );

  const encorePackager = new EncorePackager(config.packaging);
  logger.info('Starting redis listener');
  const redisListener = new RedisListener(
    config.redis,
    (message) => {
      return encorePackager.package(message.url);
    },
    config.packaging.concurrency,
    packageListener
  );
  redisListener.start();

  if (!config.healthcheck.disabled) {
    logger.info(
      `Starting healthcheck endpoint on ${config.healthcheck.host}:${config.healthcheck.port}`
    );
    const server = api({ redisStatus: () => redisListener.redisStatus() });
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
