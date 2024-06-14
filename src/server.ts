import api from './api';
import { readConfig } from './config';
import { RedisListener } from './redisListener';
import { packageEncoreJob } from './package';

const config = readConfig();

const server = api({ title: 'encore packager' });

server.listen({ port: config.port, host: config.host }, (err, address) => {
  if (err) {
    throw err;
  }
  console.log(`Server listening on ${address}`);
});

if (config.redis) {
  console.log('Starting redis listener');
  const redisListener = new RedisListener(config.redis, (message) => {
    return packageEncoreJob(message.url, config.package.outputFolder);
  });
  redisListener.start();
}

export default server;
