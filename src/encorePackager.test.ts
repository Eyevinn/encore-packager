import { EncoreJob, parseInputsFromEncoreJob } from './encorePackager';

describe('Test parseInputsFromEncoreJob', () => {
  it('No audio output, should not return audio input', () => {
    const job: EncoreJob = {
      id: 'e5e76304-744c-41d6-85f7-69007b3b1a65',
      status: 'SUCCESSFUL',
      output: [
        {
          file: '/data/out/e5e76304-744c-41d6-85f7-69007b3b1a65/test3_x264_3100.mp4',
          format: 'mp4',
          fileSize: 3757912,
          overallBitrate: 2982469,
          videoStreams: [
            {
              codec: 'h264',
              bitrate: 2979615
            }
          ],
          audioStreams: [],
          type: 'VideoFile'
        }
      ],
      inputs: []
    };
    const inputs = parseInputsFromEncoreJob(job);
    console.log(inputs);
  });
});
