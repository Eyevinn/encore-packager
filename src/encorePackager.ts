import {
  Input,
  doPackage,
  PackageOptions,
  PackageFormatOptions
} from '@eyevinn/shaka-packager-s3';
import { resolve } from 'node:path';
import { PackagingConfig, StreamKeyTemplates } from './config';
import { basename, extname } from 'node:path';
import { Context } from '@osaas/client-core';
import logger from './logger';

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

  async package(jobUrl: string) {
    const job = await this.getEncoreJob(jobUrl);
    const inputs = parseInputsFromEncoreJob(job, this.config.streamKeysConfig);
    let serviceAccessToken = undefined;
    if (this.config.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.config.oscAccessToken
      });
      serviceAccessToken = await ctx.getServiceAccessToken('encore');
    }
    const dest = this.getPackageDestination(job);
    const packageFormatOptions = this.getPackageFormatOptions(job);
    await doPackage({
      dest,
      s3EndpointUrl: this.config.s3EndpointUrl,
      inputs,
      source: this.config.oscAccessToken ? new URL(jobUrl).origin : undefined,
      serviceAccessToken,
      noImplicitAudio: true,
      shakaExecutable: this.config.shakaExecutable,
      stagingDir: this.config.stagingDir,
      packageFormatOptions
    } as PackageOptions);
    logger.info(`Finished packaging of job ${job.id} to output folder ${dest}`);
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
