import { resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  redis?: RedisConfig;
  encore: EncoreConfig;
  package: PackageConfig;
}

export interface EncoreConfig {
  url: string;
}

export interface RedisConfig {
  url: string;
  queueName: string;
}

export interface PackageConfig {
  outputFolder: string;
}

export function readConfig(): Config {
  return {
    host: process.env.HOST || 'localhost',
    port: parseInt(process.env.PORT || '8000'),
    redis: !process.env.REDIS_URL
      ? undefined
      : {
          url: process.env.REDIS_URL || '',
          queueName: process.env.REDIS_QUEUE_NAME || 'packaging-queue'
        },
    encore: {
      url: process.env.ENCORE_URL || ''
    },
    package: {
      outputFolder: resolve(process.env.PACKAGE_OUTPUT_FOLDER || 'out')
    }
  };
}
