import { Input, doPackage, PackageOptions } from '@eyevinn/shaka-packager-s3';
import { resolve } from 'node:path';
import { PackagingConfig } from './config';
import { basename, extname } from 'node:path';
import { Context } from '@osaas/client-core';

export interface EncoreJob {
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
    const inputs = parseInputsFromEncoreJob(job);
    let serviceAccessToken = undefined;
    if (this.config.oscAccessToken) {
      const ctx = new Context({
        personalAccessToken: this.config.oscAccessToken
      });
      serviceAccessToken = await ctx.getServiceAccessToken('encore');
    }
    const dest = this.getPackageDestination(job);
    await doPackage({
      dest,
      inputs,
      source: this.config.oscAccessToken ? new URL(jobUrl).origin : undefined,
      serviceAccessToken,
      noImplicitAudio: true,
      shakaExecutable: this.config.shakaExecutable,
      stagingDir: this.config.stagingDir,
      packageFormatOptions: this.config.packageFormatOptions
    } as PackageOptions);
    console.log(`Finished packaging of job ${job.id} to output folder ${dest}`);
  }

  getPackageDestination(job: EncoreJob) {
    const inputUri = job.inputs[0].uri;
    const inputBasename = basename(inputUri, extname(inputUri));
    if (this.config.outputFolder.match(/^s3:/)) {
      return new URL(
        this.config.outputFolder + inputBasename + '/' + job.id
      ).toString();
    } else {
      return resolve(this.config.outputFolder, inputBasename, job.id);
    }
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

export function parseInputsFromEncoreJob(job: EncoreJob) {
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
    const key = `${videoIdx++}_${bitrateKb}`;
    inputs.push({ type: 'video', key, filename: v.output.file });
  });
  let audioIdx = 0;
  audio.forEach((audio) => {
    const key = `${audioIdx++}`;
    inputs.push({ type: 'audio', key, filename: audio.output.file });
  });
  return inputs;
}

function hasStereoAudioStream(output: Output) {
  if (!output.audioStreams || output.audioStreams.length === 0) {
    return false;
  }
  return output.audioStreams.filter((a) => a.channels === 2).length > 0;
}
