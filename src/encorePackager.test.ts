import { EncoreJob, parseInputsFromEncoreJob } from './encorePackager';
import { DEFAULT_STREAM_KEY_TEMPLATES } from './config';

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

const jobWithAudio: EncoreJob = {
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
    },
    {
      file: '/data/out/e5e76304-744c-41d6-85f7-69007b3b1a65/test3_x264_2300.mp4',
      format: 'mp4',
      fileSize: 2757912,
      overallBitrate: 2379615,
      videoStreams: [
        {
          codec: 'h264',
          bitrate: 2379615
        }
      ],
      audioStreams: [],
      type: 'VideoFile'
    },
    {
      file: '/data/out/e5e76304-744c-41d6-85f7-69007b3b1a65/test3_STEREO.mp4',
      format: 'mp4',
      fileSize: 3000,
      overallBitrate: 29800,
      videoStreams: [],
      audioStreams: [
        {
          codec: 'aac',
          bitrate: 128000,
          channels: 2
        }
      ],
      type: 'AudioFile'
    }
  ],
  inputs: []
};

describe('Test parseInputsFromEncoreJob', () => {
  it('No audio output, should not return audio input', () => {
    const inputs = parseInputsFromEncoreJob(job, DEFAULT_STREAM_KEY_TEMPLATES);
    expect(inputs).toEqual([
      {
        type: 'video',
        key: '0_2980',
        filename: job?.output?.[0]?.file
      }
    ]);
  });

  it('Key template with VIDEOIDX and AUDIOIDX, ', () => {
    const inputs = parseInputsFromEncoreJob(jobWithAudio, {
      video: '$VIDEOIDX$',
      audio: 'audio-$AUDIOIDX$'
    });
    expect(inputs).toEqual([
      {
        type: 'video',
        key: '0',
        filename: jobWithAudio?.output?.[0]?.file
      },
      {
        type: 'video',
        key: '1',
        filename: jobWithAudio?.output?.[1]?.file
      },
      {
        type: 'audio',
        key: 'audio-0',
        filename: jobWithAudio?.output?.[2]?.file
      }
    ]);
  });

  it('Key template with VIDEOIDX, TOTALIDX and BITRATE ', () => {
    const inputs = parseInputsFromEncoreJob(jobWithAudio, {
      video: '$VIDEOIDX$_$BITRATE$',
      audio: '$TOTALIDX$'
    });
    expect(inputs).toEqual([
      {
        type: 'video',
        key: '0_2980',
        filename: jobWithAudio?.output?.[0]?.file
      },
      {
        type: 'video',
        key: '1_2380',
        filename: jobWithAudio?.output?.[1]?.file
      },
      {
        type: 'audio',
        key: '2',
        filename: jobWithAudio?.output?.[2]?.file
      }
    ]);
  });
});
