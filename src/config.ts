import { resolve } from 'node:path';

export interface Config {
  healthcheck: HealthCheckConfig;
  redis: RedisConfig;
  packaging: PackagingConfig;
}

export interface HealthCheckConfig {
  host: string;
  port: number;
  disabled: boolean;
}

export interface RedisConfig {
  url: string;
  queueName: string;
}

export interface PackagingConfig {
  outputFolder: string;
  concurrency: number;
  shakaExecutable?: string;
  packageListenerPlugin?: string;
  encorePassword?: string;
}

function readRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    queueName: process.env.REDIS_QUEUE_NAME || 'packaging-queue'
  };
}

function readPackagingConfig(): PackagingConfig {
  return {
    outputFolder: resolve(process.env.PACKAGE_OUTPUT_FOLDER || 'packaged'),
    shakaExecutable: process.env.SHAKA_PACKAGER_EXECUTABLE,
    concurrency: parseInt(process.env.PACKAGE_CONCURRENCY || '1'),
    packageListenerPlugin: process.env.PACKAGE_LISTENER_PLUGIN,
    encorePassword: process.env.ENCORE_PASSWORD
  };
}

export function readConfig(): Config {
  return {
    healthcheck: {
      host: process.env.HOST || '0.0.0.0',
      port: parseInt(process.env.PORT || '8000'),
      disabled: process.env.DISABLE_HEALTHCHECK === 'true'
    },
    redis: readRedisConfig(),
    packaging: readPackagingConfig()
  };
}
