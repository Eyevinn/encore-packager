import {
  Input,
  doPackage,
  PackageOptions,
  PackageFormatOptions
} from '@eyevinn/shaka-packager-s3';
import { resolve, join } from 'node:path';
import { PackagingConfig, StreamKeyTemplates } from './config';
import { basename, extname } from 'node:path';
import { Context } from '@osaas/client-core';
import logger from './logger';
import { SmilGenerator } from './smilGenerator';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

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

const ENCORE_BASIC_AUTH_USER = 'user';

export class EncorePackager {
  constructor(private config: PackagingConfig) {}

  async package(jobUrl: string): Promise<string> {
    const job = await this.getEncoreJob(jobUrl);
    const parsedInputs = parseInputsFromEncoreJob(
      job,
      this.config.streamKeysConfig
    );
    let serviceAccessToken = undefined;
    if (this.config.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.config.oscAccessToken
      });
      serviceAccessToken = await ctx.getServiceAccessToken('encore');
    }
    const source = this.config.oscAccessToken
      ? new URL(jobUrl).origin
      : undefined;
    // The input sources are the Encore renditions the packager reads; they are
    // not part of the package itself and are excluded from the output unless
    // explicitly asked for.
    const inputs = this.config.includeInputSources
      ? parsedInputs
      : resolveInputSourceUrls(parsedInputs, source);
    const dest = this.getPackageDestination(job);
    const packageFormatOptions = this.getPackageFormatOptions(job);
    await doPackage({
      dest,
      s3EndpointUrl: this.config.s3EndpointUrl,
      inputs,
      source,
      serviceAccessToken,
      noImplicitAudio: true,
      shakaExecutable: this.config.shakaExecutable,
      stagingDir: this.config.stagingDir,
      packageFormatOptions
    } as PackageOptions);
    if (!this.config.includeInputSources) {
      await removeInputSourcesFromOutput(
        dest,
        inputs,
        this.config.s3EndpointUrl
      );
    }
    logger.info(`Finished packaging of job ${job.id} to output folder ${dest}`);
    if (URL.canParse(dest)) {
      const parsed = new URL(dest);
      if (parsed) {
        return parsed.pathname;
      }
    }
    return dest;
  }

  async copyAndGenerateSmil(jobUrl: string): Promise<string> {
    const job = await this.getEncoreJob(jobUrl);
    const dest = this.getPackageDestination(job);

    const smilGenerator = new SmilGenerator(this.config);
    await smilGenerator.generateFromEncoreJob(job, dest, jobUrl);

    if (URL.canParse(dest)) {
      const parsed = new URL(dest);
      if (parsed) {
        return parsed.pathname;
      }
    }
    return dest;
  }

  getPackageDestination(job: EncoreJob) {
    const subfolder = this.resolveTemplate(
      this.config.outputSubfolderTemplate,
      job
    );
    if (this.config.outputFolder.match(/^s3:/)) {
      return new URL(this.config.outputFolder + subfolder).toString();
    } else {
      return resolve(this.config.outputFolder, subfolder);
    }
  }

  getPackageFormatOptions(job: EncoreJob): PackageFormatOptions {
    const packageFormatOptions: PackageFormatOptions = {
      ...this.config.packageFormatOptions
    };
    if (this.config.manifestNamesConfig.dashManifestNameTemplate) {
      packageFormatOptions.dashManifestName = this.resolveTemplate(
        this.config.manifestNamesConfig.dashManifestNameTemplate,
        job
      );
    }
    if (this.config.manifestNamesConfig.hlsManifestNameTemplate) {
      packageFormatOptions.hlsManifestName = this.resolveTemplate(
        this.config.manifestNamesConfig.hlsManifestNameTemplate,
        job
      );
    }
    return packageFormatOptions;
  }

  // This is problematic, because it doesn't respect the external ID.
  resolveTemplate(template: string, job: EncoreJob) {
    const inputUri = job.inputs[0].uri;
    const inputBasename = basename(inputUri, extname(inputUri));
    return template
      .replaceAll('$EXTERNALID$', job.externalId ? job.externalId : '')
      .replaceAll('$JOBID$', job.id)
      .replaceAll('$INPUTNAME$', inputBasename);
  }

  async getEncoreJob(url: string): Promise<EncoreJob> {
    const authHeader: { Authorization: string } | Record<string, never> = this
      .config.encorePassword
      ? {
          Authorization:
            'Basic ' +
            Buffer.from(
              `${ENCORE_BASIC_AUTH_USER}:${this.config.encorePassword}`
            ).toString('base64')
        }
      : {};
    let sat;
    if (this.config.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.config.oscAccessToken
      });
      sat = await ctx.getServiceAccessToken('encore');
    }
    const jwtHeader: { 'x-jwt': string } | Record<string, never> = sat
      ? {
          'x-jwt': `Bearer ${sat}`
        }
      : {};
    const response = await fetch(url, {
      headers: { ...authHeader, ...jwtHeader }
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch job from Encore, got status: ${response.status}`
      );
    }
    return (await response.json()) as EncoreJob;
  }
}

/**
 * Rewrite input source filenames to absolute URLs when the sources are fetched
 * from a remote HTTP source.
 *
 * Why: `download()` in @eyevinn/shaka-packager-s3@0.6.3
 * (`node_modules/@eyevinn/shaka-packager-s3/dist/packager.js`) stages an HTTP
 * source as `join(stagingDir, basename(input.filename))`, but
 * `removeDownloadedFiles()` — the upstream step that keeps source files out of
 * an S3 upload — looks for `join(stagingDir, input.filename)` unless the
 * filename contains `://`. Encore reports `output[].file` as a plain path
 * (e.g. `/data/out/<jobId>/asset_x264_3100.mp4`), so the two disagree, the
 * source file is never removed from the staging dir and `aws s3 cp
 * --recursive` uploads it alongside the segments and playlists. Passing an
 * absolute URL makes both use `basename()`, so the sources are dropped before
 * the upload instead of being uploaded and deleted afterwards.
 *
 * The resulting URL is the same one upstream builds for the download itself
 * (`new URL(filePath, baseUrl)` against the source origin), so this does not
 * change which file is fetched.
 */
export function resolveInputSourceUrls(
  inputs: Input[],
  source?: string
): Input[] {
  if (!source) {
    // Without a source, upstream `download()` hands the filename straight to
    // the packager and never copies anything into the package directory.
    return inputs;
  }
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    return inputs;
  }
  if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') {
    // Upstream resolves s3: sources differently; leave those untouched.
    return inputs;
  }
  return inputs.map((input) => {
    if (input.filename.includes('://')) {
      return input;
    }
    return {
      ...input,
      filename: new URL(input.filename, sourceUrl).toString()
    };
  });
}

/**
 * Names the input source files get when they are copied into the package
 * output. Only inputs that upstream `download()` actually fetches into the
 * staging directory (remote URLs) can end up there; local paths are read in
 * place and must never be deleted.
 *
 * Mirrors `basename(input.filename)` from `download()` in
 * @eyevinn/shaka-packager-s3@0.6.3 (`dist/packager.js`), which is the name the
 * staged copy is written under.
 */
export function inputSourceFilesInOutput(inputs: Input[]): string[] {
  const names = new Set<string>();
  for (const input of inputs) {
    if (!input.filename.includes('://')) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(input.filename);
    } catch {
      continue;
    }
    if (url.protocol === 'file:') {
      continue;
    }
    const name = basename(input.filename);
    if (name.length > 0) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Remove any input source files that were copied into the package output, so
 * the output holds only the generated segments, playlists and manifests.
 *
 * Generated files cannot collide with these names: segments and playlists are
 * named from the stream keys (`video-$KEY$`, `audio`) and the manifest name
 * templates, never from the Encore rendition filename.
 *
 * A failed cleanup is logged but does not fail an otherwise successful job.
 */
export async function removeInputSourcesFromOutput(
  dest: string,
  inputs: Input[],
  s3EndpointUrl?: string
): Promise<void> {
  const files = inputSourceFilesInOutput(inputs);
  if (files.length === 0) {
    return;
  }
  const isS3 = URL.canParse(dest) && new URL(dest).protocol === 's3:';
  for (const file of files) {
    try {
      if (isS3) {
        removeFromS3(`${dest.replace(/\/+$/, '')}/${file}`, s3EndpointUrl);
      } else {
        const path = join(dest, file);
        if (existsSync(path)) {
          await unlink(path);
          logger.info(`Removed input source ${path} from packaged output`);
        }
      }
    } catch (err) {
      logger.warn(
        `Failed to remove input source ${file} from ${dest}: ${
          (err as Error)?.message
        }`
      );
    }
  }
}

function removeFromS3(url: string, s3EndpointUrl?: string): void {
  const args = ['s3', 'rm', url];
  if (s3EndpointUrl) {
    args.push('--endpoint-url', s3EndpointUrl);
  }
  const { status, error } = spawnSync('aws', args, { stdio: 'ignore' });
  if (status !== 0) {
    throw error ?? new Error(`aws s3 rm failed with exit code ${status}`);
  }
  logger.info(`Removed input source ${url} from packaged output`);
}

export function parseInputsFromEncoreJob(
  job: EncoreJob,
  streamKeysConfig: StreamKeyTemplates
) {
  const inputs: Input[] = [];

  if (job.status !== 'SUCCESSFUL') {
    throw new Error('Encore job is not successful');
  }
  if (!job.output) {
    throw new Error('Encore job has no output');
  }
  const video = job.output
    .filter((output) => output.type === 'VideoFile')
    .map((output) => ({ output, videoStream: output.videoStreams?.[0] }));
  const audio = job.output
    .filter((output) => output.type === 'AudioFile')
    .map((output) => ({ output, audioStream: output.audioStreams?.[0] }))
    .filter((v) => v.audioStream?.channels === 2);

  if (audio.length === 0) {
    const moreAudio = job.output
      .filter((output) => output.type === 'VideoFile')
      .filter(hasStereoAudioStream)
      .map((output) => ({
        output,
        audioStream: output.audioStreams?.filter((a) => a.channels === 2)[0]
      }));
    if (moreAudio.length > 0) {
      audio.push(moreAudio[0]);
    }
  }
  let videoIdx = 0;
  video.forEach((v) => {
    const bitrateKb = v.videoStream?.bitrate
      ? Math.round(v.videoStream?.bitrate / 1000)
      : 0;
    const key = keyFromTemplate(streamKeysConfig.video, {
      videoIdx,
      audioIdx: 0,
      totalIdx: videoIdx,
      bitrate: bitrateKb
    });
    inputs.push({ type: 'video', key, filename: v.output.file });
    videoIdx++;
  });
  let audioIdx = 0;
  audio.forEach((audio) => {
    const bitrateKb = audio.audioStream?.bitrate
      ? Math.round(audio.audioStream?.bitrate / 1000)
      : 0;
    const key = keyFromTemplate(streamKeysConfig.audio, {
      videoIdx,
      audioIdx,
      totalIdx: videoIdx + audioIdx,
      bitrate: bitrateKb
    });
    inputs.push({ type: 'audio', key, filename: audio.output.file });
    audioIdx++;
  });
  return inputs;
}

function keyFromTemplate(
  template: string,
  values: {
    videoIdx: number;
    audioIdx: number;
    totalIdx: number;
    bitrate: number;
  }
) {
  return template
    .replaceAll('$VIDEOIDX$', `${values.videoIdx}`)
    .replaceAll('$AUDIOIDX$', `${values.audioIdx}`)
    .replaceAll('$TOTALIDX$', `${values.totalIdx}`)
    .replaceAll('$BITRATE$', `${values.bitrate}`);
}

function hasStereoAudioStream(output: Output) {
  if (!output.audioStreams || output.audioStreams.length === 0) {
    return false;
  }
  return output.audioStreams.filter((a) => a.channels === 2).length > 0;
}
