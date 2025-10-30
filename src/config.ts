import { resolve } from 'node:path';
import { PackageFormatOptions } from '@eyevinn/shaka-packager-s3';

export interface Config {
  healthcheck: HealthCheckConfig;
  redis: RedisConfig;
  packaging: PackagingConfig;
  callback: CallbackConfig;
}

export interface HealthCheckConfig {
  host: string;
  port: number;
  disabled: boolean;
}

export interface RedisConfig {
  url: string;
  queueName: string;
  clusterMode: boolean;
}

export interface CallbackConfig {
  url?: URL;
  user?: string;
  password?: string;
}

export interface PackagingConfig {
  outputFolder: string;
  outputSubfolderTemplate: string;
  concurrency: number;
  shakaExecutable?: string;
  packageListenerPlugin?: string;
  encorePassword?: string;
  oscAccessToken?: string;
  stagingDir?: string;
  packageFormatOptions?: PackageFormatOptions;
  streamKeysConfig: StreamKeyTemplates;
  manifestNamesConfig: ManifestNameTemplates;
  s3EndpointUrl?: string;
  skipPackaging: boolean;
}

export const DEFAULT_OUTPUT_SUBFOLDER_TEMPLATE = '$INPUTNAME$/$JOBID$';

export interface StreamKeyTemplates {
  video: string;
  audio: string;
}

export const DEFAULT_STREAM_KEY_TEMPLATES: StreamKeyTemplates = {
  video: '$VIDEOIDX$_$BITRATE$',
  audio: '$AUDIOIDX$'
};

export interface ManifestNameTemplates {
  dashManifestNameTemplate?: string;
  hlsManifestNameTemplate?: string;
}

function readRedisConfig(): RedisConfig {
  return {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    queueName: process.env.REDIS_QUEUE || 'packaging-queue',
    clusterMode: process.env.REDIS_CLUSTER === 'true'
  };
}

export function readCallbackConfig(): CallbackConfig {
  let url: URL | null = null;
  if (process.env.CALLBACK_URL) {
    try {
      url = new URL(process.env.CALLBACK_URL);
    } catch {
      url = null;
    }
  }
  const user =
    url?.username && url.username.length > 0 ? url.username : undefined;
  const password = url && url.password.length > 0 ? url.password : undefined;
  const urlStr = url ? stripUserFromUrl(url) : undefined;
  if (urlStr) {
    return {
      url: urlStr,
      user: user,
      password: password
    };
  }
  return {};
}

function stripUserFromUrl(url: URL): URL | null {
  try {
    return new URL(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    return null;
  }
}

function readPackagingConfig(): PackagingConfig {
  const packageFormatOptions = process.env.PACKAGE_FORMAT_OPTIONS_JSON
    ? (JSON.parse(
        process.env.PACKAGE_FORMAT_OPTIONS_JSON
      ) as PackageFormatOptions)
    : undefined;

  const streamKeysConfig: StreamKeyTemplates = {
    video:
      process.env.VIDEO_STREAM_KEY_TEMPLATE ||
      DEFAULT_STREAM_KEY_TEMPLATES.video,
    audio:
      process.env.AUDIO_STREAM_KEY_TEMPLATE ||
      DEFAULT_STREAM_KEY_TEMPLATES.audio
  };

  const manifestNamesConfig: ManifestNameTemplates = {
    dashManifestNameTemplate: process.env.DASH_MANIFEST_NAME_TEMPLATE,
    hlsManifestNameTemplate: process.env.HLS_MANIFEST_NAME_TEMPLATE
  };

  return {
    outputFolder: process.env.PACKAGE_OUTPUT_FOLDER?.match(/^s3:/)
      ? new URL(process.env.PACKAGE_OUTPUT_FOLDER).toString()
      : resolve(process.env.PACKAGE_OUTPUT_FOLDER || 'packaged'),
    outputSubfolderTemplate:
      process.env.OUTPUT_SUBFOLDER_TEMPLATE ||
      DEFAULT_OUTPUT_SUBFOLDER_TEMPLATE,
    shakaExecutable: process.env.SHAKA_PACKAGER_EXECUTABLE,
    concurrency: parseInt(process.env.PACKAGE_CONCURRENCY || '1'),
    packageListenerPlugin: process.env.PACKAGE_LISTENER_PLUGIN,
    encorePassword: process.env.ENCORE_PASSWORD,
    oscAccessToken: process.env.OSC_ACCESS_TOKEN,
    stagingDir: process.env.STAGING_DIR,
    packageFormatOptions,
    streamKeysConfig,
    manifestNamesConfig,
    s3EndpointUrl: process.env.S3_ENDPOINT_URL,
    skipPackaging: process.env.SKIP_PACKAGING === 'true'
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
    packaging: readPackagingConfig(),
    callback: readCallbackConfig()
  };
}
