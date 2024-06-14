import api from './api';
import { RedisListener } from './redisListener';
import { EncorePackager } from './encorePackager';
import { Config } from './config';

export function startListener(config: Config) {
  const encorePackager = new EncorePackager(config.packaging);
  console.log('Starting redis listener');
  const redisListener = new RedisListener(
    config.redis,
    (message) => {
      return encorePackager.package(message.url);
    },
    config.packaging.concurrency
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
