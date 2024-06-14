import { Input, doPackage } from '@eyevinn/shaka-packager-s3';
import { resolve } from 'node:path';

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

export async function packageEncoreJob(jobUrl: string, outputFolder: string) {
  const job = await getEncoreJob(jobUrl);
  const inputs = parseInputsFromEncoreJob(job);
  const dest = resolve(outputFolder, job.id);
  await doPackage({
    dest,
    source: undefined,
    inputs,
    stagingDir: undefined,
    noImplicitAudio: true
  });
}

async function getEncoreJob(url: string): Promise<EncoreJob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch job from Encore, got status: ${response.status}`
    );
  }
  return (await response.json()) as EncoreJob;
}

export async function inputsFromEncoreJob(jobUrl: string): Promise<Input[]> {
  const encoreJob = await getEncoreJob(jobUrl);
  return parseInputsFromEncoreJob(encoreJob);
}

function parseInputsFromEncoreJob(job: EncoreJob) {
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
      .filter(
        (output) =>
          output.audioStreams?.filter((a) => a.channels === 2)?.length || 0 > 0
      )
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
