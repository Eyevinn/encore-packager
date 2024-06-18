import { Input, doPackage, PackageOptions } from '@eyevinn/shaka-packager-s3';
import { resolve } from 'node:path';
import { PackagingConfig } from './config';

export interface EncoreJob {
  id: string;
  status: string;
  output?: Output[];
}

export interface Output {
  type: string;
  file: string;
  fileSize: number;
  overallBitrate: number;
  videoStreams?: { codec: string; bitrate: number }[];
  audioStreams?: { codec: string; bitrate: number; channels: number }[];
}

export class EncorePackager {
  constructor(private config: PackagingConfig) {}

  async package(jobUrl: string) {
    const job = await this.getEncoreJob(jobUrl);
    const inputs = parseInputsFromEncoreJob(job);
    const dest = resolve(this.config.outputFolder, job.id);
    await doPackage({
      dest,
      inputs,
      noImplicitAudio: true,
      shakaExecutable: this.config.shakaExecutable
    } as PackageOptions);
    console.log(`Finished packaging of job ${job.id} to output folder ${dest}`);
  }

  async getEncoreJob(url: string): Promise<EncoreJob> {
    const response = await fetch(url);
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
