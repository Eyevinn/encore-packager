import { Input } from '@eyevinn/shaka-packager-s3';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inputSourceFilesInOutput,
  removeInputSourcesFromOutput,
  resolveInputSourceUrls
} from './encorePackager';
import { readConfig } from './config';

const encoreInputs: Input[] = [
  {
    type: 'video',
    key: '0_2980',
    filename: '/data/out/job-id/test3_x264_3100.mp4'
  },
  {
    type: 'audio',
    key: '0',
    filename: '/data/out/job-id/test3_STEREO.mp4'
  }
];

describe('resolveInputSourceUrls', () => {
  it('resolves plain Encore output paths against an HTTP source', () => {
    const inputs = resolveInputSourceUrls(
      encoreInputs,
      'https://encore.example.com'
    );
    expect(inputs.map((i) => i.filename)).toEqual([
      'https://encore.example.com/data/out/job-id/test3_x264_3100.mp4',
      'https://encore.example.com/data/out/job-id/test3_STEREO.mp4'
    ]);
    expect(inputs.map((i) => i.key)).toEqual(['0_2980', '0']);
    expect(inputs.map((i) => i.type)).toEqual(['video', 'audio']);
  });

  it('leaves inputs untouched when no source is configured', () => {
    expect(resolveInputSourceUrls(encoreInputs)).toEqual(encoreInputs);
  });

  it('leaves absolute URLs and non-HTTP sources untouched', () => {
    const absolute: Input[] = [
      { type: 'video', key: '0', filename: 'https://host/a/b.mp4' }
    ];
    expect(
      resolveInputSourceUrls(absolute, 'https://encore.example.com')
    ).toEqual(absolute);
    expect(resolveInputSourceUrls(encoreInputs, 's3://bucket/prefix')).toEqual(
      encoreInputs
    );
    expect(resolveInputSourceUrls(encoreInputs, 'not a url')).toEqual(
      encoreInputs
    );
  });
});

describe('inputSourceFilesInOutput', () => {
  it('returns the staged filename for remote sources', () => {
    expect(
      inputSourceFilesInOutput(
        resolveInputSourceUrls(encoreInputs, 'https://encore.example.com')
      )
    ).toEqual(['test3_x264_3100.mp4', 'test3_STEREO.mp4']);
  });

  it('returns nothing for local sources, which are read in place', () => {
    expect(inputSourceFilesInOutput(encoreInputs)).toEqual([]);
    expect(
      inputSourceFilesInOutput([
        { type: 'video', key: '0', filename: 'file:///data/out/a.mp4' }
      ])
    ).toEqual([]);
  });

  it('de-duplicates inputs sharing one source file', () => {
    expect(
      inputSourceFilesInOutput([
        { type: 'video', key: '0', filename: 'https://host/out/a.mp4' },
        { type: 'audio', key: '0', filename: 'https://host/out/a.mp4' }
      ])
    ).toEqual(['a.mp4']);
  });
});

describe('removeInputSourcesFromOutput', () => {
  async function createPackagedOutput(): Promise<string> {
    const dest = await mkdtemp(join(tmpdir(), 'packaged-'));
    await writeFile(join(dest, 'test3_x264_3100.mp4'), 'source rendition');
    await writeFile(join(dest, 'test3_STEREO.mp4'), 'source rendition');
    await writeFile(join(dest, 'index.m3u8'), 'playlist');
    await writeFile(join(dest, 'manifest.mpd'), 'manifest');
    await writeFile(join(dest, 'video-0_2980.m3u8'), 'playlist');
    await mkdir(join(dest, 'video-0_2980'));
    await writeFile(join(dest, 'video-0_2980', 'init.mp4'), 'segment');
    return dest;
  }

  it('leaves only segments, playlists and manifests in a local output', async () => {
    const dest = await createPackagedOutput();
    const inputs = resolveInputSourceUrls(
      encoreInputs,
      'https://encore.example.com'
    );

    await removeInputSourcesFromOutput(dest, inputs);

    expect((await readdir(dest)).sort()).toEqual([
      'index.m3u8',
      'manifest.mpd',
      'video-0_2980',
      'video-0_2980.m3u8'
    ]);
    expect(await readdir(join(dest, 'video-0_2980'))).toEqual(['init.mp4']);
  });

  it('keeps local input sources, which live outside the output', async () => {
    const dest = await createPackagedOutput();

    await removeInputSourcesFromOutput(dest, encoreInputs);

    expect((await readdir(dest)).sort()).toEqual([
      'index.m3u8',
      'manifest.mpd',
      'test3_STEREO.mp4',
      'test3_x264_3100.mp4',
      'video-0_2980',
      'video-0_2980.m3u8'
    ]);
  });

  it('is a no-op when a source file is already gone', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'packaged-'));
    await writeFile(join(dest, 'index.m3u8'), 'playlist');

    await expect(
      removeInputSourcesFromOutput(dest, [
        { type: 'video', key: '0', filename: 'https://host/out/a.mp4' }
      ])
    ).resolves.toBeUndefined();
    expect(await readdir(dest)).toEqual(['index.m3u8']);
  });
});

describe('includeInputSources config', () => {
  afterEach(() => {
    delete process.env.INCLUDE_INPUT_SOURCES;
  });

  it('excludes input sources by default', () => {
    expect(readConfig().packaging.includeInputSources).toEqual(false);
  });

  it('can be opted into with INCLUDE_INPUT_SOURCES', () => {
    process.env.INCLUDE_INPUT_SOURCES = 'true';
    expect(readConfig().packaging.includeInputSources).toEqual(true);
  });
});
