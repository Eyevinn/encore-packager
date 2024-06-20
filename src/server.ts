import api from './api';
import { RedisListener } from './redisListener';
import { EncorePackager } from './encorePackager';
import { Config } from './config';
import { PackageListener } from './packageListener';

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
    console.error(
      `Failed to load notifications module from ${pluginPath}`,
      err
    );
  }
  return undefined;
}

export async function startListener(config: Config) {
  const packageListener = await loadPackageListener(
    config.packaging.packageListenerPlugin
  );

  const encorePackager = new EncorePackager(config.packaging);
  console.log('Starting redis listener');
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
    console.log(
      `Starting healthcheck endpoint on ${config.healthcheck.host}:${config.healthcheck.port}`
    );
    const server = api({ redisStatus: () => redisListener.redisStatus() });
    server.listen(
      { port: config.healthcheck.port, host: config.healthcheck.host },
      (err, address) => {
        if (err) {
          throw err;
        }
        console.log(`Server listening on ${address}`);
      }
    );
  }
}
