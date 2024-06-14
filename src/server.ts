import api from './api';
import { readConfig } from './config';
import { RedisListener } from './redisListener';
import { EncorePackager } from './encorePackager';

const config = readConfig();

const server = api({ title: 'encore packager' });

server.listen({ port: config.port, host: config.host }, (err, address) => {
  if (err) {
    throw err;
  }
  console.log(`Server listening on ${address}`);
});

const encorePackager = new EncorePackager(config.packaging);
console.log('Starting redis listener');
const redisListener = new RedisListener(
  config.redis!,
  (message) => {
    return encorePackager.package(message.url);
  },
  config.packaging.concurrency
);
redisListener.start();

export default server;
