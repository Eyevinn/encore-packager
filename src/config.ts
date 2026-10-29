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
  includeInputSources: boolean;
  downloadRetryCount: number;
  downloadRetryDelaySeconds: number;
  downloadMaxTimeSeconds: number;
  downloadAppRetryAttempts: number;
}

export const DEFAULT_OUTPUT_SUBFOLDER_TEMPLATE = '$INPUTNAME$/$JOBID$';
export const DEFAULT_OUTPUT_FOLDER = 'packaged';

// Renditions can be large (800MB-2GB+), so curl's --max-time needs enough
// headroom to survive a full transfer over a slow/congested link, not just a
// LAN-speed copy.
export const DEFAULT_DOWNLOAD_RETRY_COUNT = 3;
export const DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS = 2;
export const DEFAULT_DOWNLOAD_MAX_TIME_SECONDS = 900;
// Application-level retry attempts, on top of (and independent from)
// curl's own --retry above. This is the safety net for a file that still
// fails after curl has exhausted its own transient-error retries.
export const DEFAULT_DOWNLOAD_APP_RETRY_ATTEMPTS = 3;

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

/**
 * The output folder is joined with the resolved output subfolder to build the
 * package destination (`getPackageDestination` in encorePackager.ts). For an S3
 * URI that join is a plain string concatenation, so the folder has to end with
 * a separator: without one, `s3://bucket/prefix` + `asset/job` becomes
 * `s3://bucket/prefixasset/job`, and a bare `s3://bucket` + `asset/job` even
 * moves the output to a different bucket (`s3://bucketasset/job`). Local paths
 * are joined with `path.resolve`, which inserts the separator itself, so they
 * are only made absolute here — as before.
 */
export function normalizeOutputFolder(outputFolder?: string): string {
  const folder = outputFolder || DEFAULT_OUTPUT_FOLDER;
  if (folder.match(/^s3:/)) {
    const uri = new URL(folder).toString();
    return uri.endsWith('/') ? uri : `${uri}/`;
  }
  return resolve(folder);
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
    outputFolder: normalizeOutputFolder(process.env.PACKAGE_OUTPUT_FOLDER),
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
    skipPackaging: process.env.SKIP_PACKAGING === 'true',
    // The packaged output contains only segments, playlists and manifests by
    // default. Opting in restores the previous behaviour of leaving the input
    // source renditions in the output as well.
    includeInputSources: process.env.INCLUDE_INPUT_SOURCES === 'true',
    downloadRetryCount: parseInt(
      process.env.DOWNLOAD_RETRY_COUNT || `${DEFAULT_DOWNLOAD_RETRY_COUNT}`
    ),
    downloadRetryDelaySeconds: parseInt(
      process.env.DOWNLOAD_RETRY_DELAY_SECONDS ||
        `${DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS}`
    ),
    downloadMaxTimeSeconds: parseInt(
      process.env.DOWNLOAD_MAX_TIME_SECONDS ||
        `${DEFAULT_DOWNLOAD_MAX_TIME_SECONDS}`
    ),
    downloadAppRetryAttempts: parseInt(
      process.env.DOWNLOAD_APP_RETRY_ATTEMPTS ||
        `${DEFAULT_DOWNLOAD_APP_RETRY_ATTEMPTS}`
    )
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
