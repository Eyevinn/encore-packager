import { resolve, join } from 'node:path';
import { basename } from 'node:path';
import { Context } from '@osaas/client-core';
import logger from './logger';
import { copyFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  PackagingConfig,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS,
  DEFAULT_DOWNLOAD_MAX_TIME_SECONDS,
  DEFAULT_DOWNLOAD_APP_RETRY_ATTEMPTS
} from './config';
import { rm } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { delay } from './util';

export interface EncoreJob {
  externalId?: string;
  id: string;
  status: string;
  output?: Output[];
  inputs: EncoreInput[];
}

export interface Output {
  type: string;
  format: string;
  file: string;
  fileSize: number;
  overallBitrate: number;
  videoStreams?: { codec: string; bitrate: number }[];
  audioStreams?: { codec: string; bitrate: number; channels: number }[];
}

export interface EncoreInput {
  uri: string;
}

export interface SmilEntry {
  file: string;
  bitrate: number;
}

const DEFAULT_STAGING_DIR = '/tmp/data';

function createS3cmdArgs(args: string[], s3EndpointUrl?: string): string[] {
  if (s3EndpointUrl) {
    return [...args, '--endpoint-url', s3EndpointUrl];
  }
  return args;
}

async function prepareStagingDirectory(
  stagingDir = DEFAULT_STAGING_DIR
): Promise<string> {
  const jobId = Math.random().toString(36).substring(7);
  const jobDir = join(stagingDir, jobId);
  if (!existsSync(jobDir)) {
    mkdirSync(jobDir, { recursive: true });
  }
  return jobDir;
}

export class SmilGenerator {
  constructor(private config: PackagingConfig) {}

  async generateFromEncoreJob(
    job: EncoreJob,
    destination: string,
    jobUrl: string
  ): Promise<string> {
    let serviceAccessToken = undefined;
    if (this.config.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.config.oscAccessToken
      });
      serviceAccessToken = await ctx.getServiceAccessToken('encore');
    }

    if (!job.output) {
      throw new Error('Encore job has no output');
    }

    const mp4Files = job.output.filter(
      (output) => output.type === 'VideoFile' && output.format === 'MPEG-4'
    );

    if (mp4Files.length === 0) {
      throw new Error('No MP4 files found in Encore job output');
    }

    // Determine if we're uploading to S3
    const isS3Destination = destination.startsWith('s3:');
    let workingDir = destination;

    // If uploading to S3, use the configured staging directory
    if (isS3Destination) {
      workingDir = await prepareStagingDirectory(this.config.stagingDir);
      logger.info(`Using staging directory: ${workingDir}`);
    } else {
      // Create destination directory for local output
      await mkdir(destination, { recursive: true });
    }

    // Download MP4 files and collect file info for SMIL
    const smilEntries: SmilEntry[] = [];

    for (const mp4File of mp4Files) {
      const sourceUrl = mp4File.file;
      const filename = basename(sourceUrl);
      const destPath = resolve(workingDir, filename);

      // Resume support: if a previous attempt for this job already
      // downloaded this exact file into this working directory (verified by
      // comparing to the expected size from the Encore job output, not just
      // presence, since a prior failed/interrupted curl run can leave a
      // partial file behind), skip re-downloading it.
      if (this.isFileAlreadyDownloaded(destPath, mp4File.fileSize)) {
        logger.info(
          `Skipping download of ${sourceUrl}, ${destPath} already exists with expected size`
        );
      } else {
        logger.info(`Downloading ${sourceUrl} to ${destPath}`);

        // Download the MP4 file from the Encore job output
        const source = this.config.oscAccessToken
          ? new URL(jobUrl).origin
          : undefined;
        await this.downloadFileWithRetry(
          sourceUrl,
          destPath,
          serviceAccessToken,
          source
        );
      }

      smilEntries.push({
        file: filename,
        bitrate: mp4File.overallBitrate || 0
      });
    }

    // Generate SMIL file
    const smilContent = this.generateSmilContent(smilEntries);
    const smilPath = resolve(workingDir, 'playlist.smil');
    await writeFile(smilPath, smilContent, 'utf8');

    logger.info(`Generated SMIL file at ${smilPath}`);

    // Upload to S3 if needed
    if (isS3Destination) {
      await this.uploadToS3(workingDir, destination);

      // Clean up staging directory
      await rm(workingDir, { recursive: true, force: true });
      logger.info(`Cleaned up staging directory: ${workingDir}`);
    }

    logger.info(
      `Finished copying MP4 files and generating SMIL for job ${job.id} to output folder ${destination}`
    );

    return destination;
  }

  /**
   * Returns true if a file for a previous, now-retried job attempt already
   * exists at destPath and its size matches the expected size reported by
   * Encore. Only trust presence when the size matches: curl writes directly
   * to destPath, so a file left behind by an aborted/failed attempt can be
   * present but incomplete, and treating that as "done" would ship a
   * corrupted rendition. When expectedSize is falsy (unknown), we cannot
   * safely verify completeness, so we always re-download.
   */
  private isFileAlreadyDownloaded(
    destPath: string,
    expectedSize?: number
  ): boolean {
    if (!expectedSize || !existsSync(destPath)) {
      return false;
    }
    try {
      return statSync(destPath).size === expectedSize;
    } catch {
      return false;
    }
  }

  /**
   * Wraps downloadFile with a bounded number of application-level retries
   * and exponential backoff. curl's own --retry flags already absorb
   * transient network blips (connection reset, connection refused) inside a
   * single curl invocation; this is an outer safety net for the case where a
   * file still fails after curl has exhausted its own retries, so one bad
   * file doesn't abort the entire packaging job.
   */
  private async downloadFileWithRetry(
    url: string,
    destPath: string,
    serviceAccessToken?: string,
    source?: string
  ): Promise<void> {
    const maxAttempts = Math.max(
      1,
      (this.config.downloadAppRetryAttempts ??
        DEFAULT_DOWNLOAD_APP_RETRY_ATTEMPTS) + 1
    );
    const baseDelaySeconds =
      this.config.downloadRetryDelaySeconds ??
      DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          logger.info(
            `Retrying download of ${url} (attempt ${attempt}/${maxAttempts})`
          );
        }
        await this.downloadFile(url, destPath, serviceAccessToken, source);
        return;
      } catch (err) {
        lastError = err;
        logger.error(
          `Download attempt ${attempt}/${maxAttempts} failed for ${url}: ${
            (err as Error)?.message
          }`
        );
        if (attempt < maxAttempts) {
          const backoffSeconds = baseDelaySeconds * Math.pow(2, attempt - 1);
          logger.info(
            `Waiting ${backoffSeconds}s before retrying download of ${url}`
          );
          await delay(backoffSeconds * 1000);
        }
      }
    }

    throw new Error(
      `Failed to download ${url} after ${maxAttempts} attempts: ${
        (lastError as Error)?.message
      }`
    );
  }

  private async downloadFile(
    url: string,
    destPath: string,
    serviceAccessToken?: string,
    source?: string
  ): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });

    // Convert relative URLs to absolute URLs using source
    let absoluteUrl = url;
    if (
      source &&
      !url.startsWith('http') &&
      !url.startsWith('s3:') &&
      !url.startsWith('file:')
    ) {
      absoluteUrl = new URL(url, source).toString();
    }

    // Handle S3 URLs
    if (absoluteUrl.startsWith('s3:')) {
      await this.downloadFromS3(absoluteUrl, destPath);
      return;
    }

    // Handle HTTP/HTTPS URLs with curl for better authentication support
    if (absoluteUrl.startsWith('http')) {
      await this.downloadWithCurl(absoluteUrl, destPath, serviceAccessToken);
      return;
    }

    // Handle local files
    if (absoluteUrl.startsWith('file:')) {
      const localPath = absoluteUrl.replace('file://', '');
      await copyFile(localPath, destPath);
      return;
    }

    // Fallback to basic fetch for other protocols
    const response = await fetch(absoluteUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download file from ${absoluteUrl}: ${response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    await writeFile(destPath, Buffer.from(arrayBuffer));
  }

  private async downloadWithCurl(
    url: string,
    destPath: string,
    serviceAccessToken?: string
  ): Promise<void> {
    const retryCount =
      this.config.downloadRetryCount ?? DEFAULT_DOWNLOAD_RETRY_COUNT;
    const retryDelaySeconds =
      this.config.downloadRetryDelaySeconds ??
      DEFAULT_DOWNLOAD_RETRY_DELAY_SECONDS;
    const maxTimeSeconds =
      this.config.downloadMaxTimeSeconds ?? DEFAULT_DOWNLOAD_MAX_TIME_SECONDS;

    const args = [
      '-s',
      '-S',
      '-L',
      // Let curl self-heal transient network errors (e.g. curl exit 56
      // "Recv failure: Connection reset by peer", or a refused connection)
      // within a single invocation before we fall back to an
      // application-level retry.
      '--retry',
      `${retryCount}`,
      '--retry-connrefused',
      '--retry-delay',
      `${retryDelaySeconds}`,
      '--max-time',
      `${maxTimeSeconds}`,
      '-o',
      destPath
    ];

    // Add JWT authentication if available
    if (serviceAccessToken) {
      args.push('-H');
      args.push(`x-jwt: Bearer ${serviceAccessToken}`);
    }

    args.push(url);

    return new Promise((resolve, reject) => {
      const curl = spawn('curl', args);
      let stderr = '';

      curl.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      curl.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`curl failed with code ${code}: ${stderr}`));
        } else {
          logger.info(`Successfully downloaded ${url} to ${destPath}`);
          resolve();
        }
      });

      curl.on('error', (err) => {
        reject(new Error(`curl spawn error: ${err.message}`));
      });
    });
  }

  private async downloadFromS3(url: string, destPath: string): Promise<void> {
    const args = ['s3', 'cp'];

    // Add S3 endpoint URL if configured
    if (this.config.s3EndpointUrl) {
      args.push('--endpoint-url', this.config.s3EndpointUrl);
    }

    args.push(url, destPath);

    return new Promise((resolve, reject) => {
      const aws = spawn('aws', args);
      let stderr = '';

      aws.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      aws.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`aws s3 cp failed with code ${code}: ${stderr}`));
        } else {
          logger.info(`Successfully downloaded ${url} to ${destPath}`);
          resolve();
        }
      });

      aws.on('error', (err) => {
        reject(new Error(`aws cli spawn error: ${err.message}`));
      });
    });
  }

  private generateSmilContent(entries: SmilEntry[]): string {
    const videos = entries
      .map((entry) => {
        const bitrateAttr = entry.bitrate
          ? ` system-bitrate="${entry.bitrate}"`
          : '';
        return `    <video src="${entry.file}"${bitrateAttr} />`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<smil xmlns="http://www.w3.org/2001/SMIL20/Language">
  <head>
    <meta base="${process.env.SMIL_BASE_URL || ''}" />
  </head>
  <body>
    <switch>
${videos}
    </switch>
  </body>
</smil>`;
  }

  private async uploadToS3(
    stagingDir: string,
    s3Destination: string
  ): Promise<void> {
    logger.info(`Uploading package to ${s3Destination}`);

    // Read directory to get all files
    const files = await readdir(stagingDir);

    // Separate MP4 files from SMIL file
    const mp4Files = files.filter((file) => file.endsWith('.mp4'));
    const smilFile = files.find((file) => file.endsWith('.smil'));

    // Upload MP4 files first
    for (const file of mp4Files) {
      const localPath = resolve(stagingDir, file);
      const s3Path = `${s3Destination}/${file}`;

      const args = createS3cmdArgs(
        ['s3', 'cp', localPath, s3Path],
        this.config.s3EndpointUrl
      );

      const { status, error } = spawnSync('aws', args, {
        stdio: 'inherit'
      });

      if (status !== 0) {
        if (error) {
          logger.error(`Upload failed for ${file}: ${error.message}`);
        } else {
          logger.error(`Upload failed for ${file} with exit code ${status}`);
        }
        throw new Error(`Upload failed for ${file}`);
      }

      logger.info(`Successfully uploaded ${file} to ${s3Path}`);
    }

    // Upload SMIL file last
    if (smilFile) {
      const localPath = resolve(stagingDir, smilFile);
      const s3Path = `${s3Destination}/${smilFile}`;

      const args = createS3cmdArgs(
        ['s3', 'cp', localPath, s3Path],
        this.config.s3EndpointUrl
      );

      const { status, error } = spawnSync('aws', args, {
        stdio: 'inherit'
      });

      if (status !== 0) {
        if (error) {
          logger.error(`Upload failed for ${smilFile}: ${error.message}`);
        } else {
          logger.error(
            `Upload failed for ${smilFile} with exit code ${status}`
          );
        }
        throw new Error(`Upload failed for ${smilFile}`);
      }

      logger.info(`Successfully uploaded ${smilFile} to ${s3Path}`);
    }

    logger.info(`Successfully uploaded all files to ${s3Destination}`);
  }
}
