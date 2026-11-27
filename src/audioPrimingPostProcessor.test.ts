import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trimAacPrimingSamples } from './audioPrimingPostProcessor';

let mockWriteFailureAfter = -1;
let mockWriteCalls = 0;

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: (...args: unknown[]) => {
      if (
        mockWriteFailureAfter >= 0 &&
        mockWriteCalls++ >= mockWriteFailureAfter
      ) {
        return Promise.reject(new Error('disk full'));
      }
      return actual.writeFile(...(args as Parameters<typeof actual.writeFile>));
    }
  };
});

function box(type: string, payload: Buffer): Buffer {
  const result = Buffer.alloc(payload.length + 8);
  result.writeUInt32BE(result.length, 0);
  result.write(type, 4, 4, 'ascii');
  payload.copy(result, 8);
  return result;
}

function fullBox(version: number, flags: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = version;
  header.writeUIntBE(flags, 1, 3);
  return Buffer.concat([header, payload]);
}

function makeInit(
  primingDuration?: number,
  trexDefaultSampleDuration?: number
): Buffer {
  const tkhd = Buffer.alloc(12);
  tkhd.writeUInt32BE(7, 8);
  const hdlr = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('soun'),
    Buffer.alloc(8)
  ]);
  const stsdPayload = Buffer.alloc(4);
  stsdPayload.writeUInt32BE(1, 0);
  const stsd = box(
    'stsd',
    fullBox(0, 0, Buffer.concat([stsdPayload, box('mp4a', Buffer.alloc(28))]))
  );
  const mdia = box(
    'mdia',
    Buffer.concat([
      box('hdlr', fullBox(0, 0, hdlr)),
      box(
        'mdhd',
        fullBox(
          0,
          0,
          (() => {
            const payload = Buffer.alloc(16);
            payload.writeUInt32BE(48000, 8);
            return payload;
          })()
        )
      ),
      box('minf', box('stbl', stsd))
    ])
  );
  const editList = primingDuration
    ? (() => {
        const elstPayload = Buffer.alloc(16);
        elstPayload.writeUInt32BE(1, 0);
        elstPayload.writeUInt32BE(4096, 4);
        elstPayload.writeInt32BE(primingDuration, 8);
        elstPayload.writeInt32BE(1, 12);
        return box('edts', box('elst', fullBox(0, 0, elstPayload)));
      })()
    : undefined;
  const trak = box(
    'trak',
    Buffer.concat([
      box('tkhd', fullBox(0, 0, tkhd)),
      ...(editList ? [editList] : []),
      mdia
    ])
  );
  const mvex = trexDefaultSampleDuration
    ? box(
        'mvex',
        box(
          'trex',
          fullBox(
            0,
            0,
            (() => {
              const payload = Buffer.alloc(20);
              payload.writeUInt32BE(7, 0);
              payload.writeUInt32BE(1, 4);
              payload.writeUInt32BE(trexDefaultSampleDuration, 8);
              return payload;
            })()
          )
        )
      )
    : undefined;
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('moov', Buffer.concat([trak, ...(mvex ? [mvex] : [])]))
  ]);
}

function makeTfhd(baseDataOffsetPresent = false): Buffer {
  const payload = Buffer.alloc(baseDataOffsetPresent ? 16 : 8);
  payload.writeUInt32BE(7, 0);
  if (baseDataOffsetPresent) payload.writeBigUInt64BE(0n, 4);
  return box(
    'tfhd',
    fullBox(0, 0x020010 | (baseDataOffsetPresent ? 0x000001 : 0), payload)
  );
}

function makeTfdt(value: number): Buffer {
  const payload = Buffer.alloc(12);
  payload.writeBigUInt64BE(BigInt(value), 0);
  return box('tfdt', fullBox(1, 0, payload.subarray(0, 12)));
}

function makeTrun(dataOffset: number, includeDuration = true): Buffer {
  const flags = includeDuration ? 0x000301 : 0x000201;
  const payload = Buffer.alloc(includeDuration ? 8 + 16 : 8 + 8);
  payload.writeUInt32BE(2, 0);
  payload.writeInt32BE(dataOffset, 4);
  if (includeDuration) {
    payload.writeUInt32BE(1024, 8);
    payload.writeUInt32BE(3, 12);
    payload.writeUInt32BE(1024, 16);
    payload.writeUInt32BE(2, 20);
  } else {
    payload.writeUInt32BE(3, 8);
    payload.writeUInt32BE(2, 12);
  }
  return box('trun', fullBox(0, flags, payload));
}

function makeSidx(
  version = 0,
  earliestPresentationTime = 0,
  subsegmentDuration = 2048
): Buffer {
  const payload = Buffer.alloc(version === 1 ? 40 : 32);
  payload.writeUInt32BE(1, 0);
  payload.writeUInt32BE(48000, 4);
  if (version === 1) {
    payload.writeBigUInt64BE(BigInt(earliestPresentationTime), 8);
    payload.writeBigUInt64BE(0n, 16);
    payload.writeUInt16BE(1, 26);
    payload.writeUInt32BE(1000, 28);
    payload.writeUInt32BE(subsegmentDuration, 32);
  } else {
    payload.writeUInt32BE(earliestPresentationTime, 8);
    payload.writeUInt32BE(0, 12);
    payload.writeUInt16BE(1, 18);
    payload.writeUInt32BE(1000, 20);
    payload.writeUInt32BE(subsegmentDuration, 24);
  }
  return box('sidx', fullBox(version, 0, payload));
}

function makeSegment(
  tfdt: number,
  includeDuration = true,
  sidxVersion = 0,
  sidxEarliestPresentationTime = tfdt,
  extraTrafChild?: Buffer,
  baseDataOffsetPresent = false
): Buffer {
  const mfhd = box('mfhd', fullBox(0, 0, Buffer.alloc(4)));
  const trafWithPlaceholder = box(
    'traf',
    Buffer.concat([
      makeTfhd(baseDataOffsetPresent),
      makeTfdt(tfdt),
      makeTrun(0, includeDuration),
      ...(extraTrafChild ? [extraTrafChild] : [])
    ])
  );
  const dataOffset =
    box('moof', Buffer.concat([mfhd, trafWithPlaceholder])).length + 8;
  const correctedTraf = box(
    'traf',
    Buffer.concat([
      makeTfhd(baseDataOffsetPresent),
      makeTfdt(tfdt),
      makeTrun(dataOffset, includeDuration),
      ...(extraTrafChild ? [extraTrafChild] : [])
    ])
  );
  return Buffer.concat([
    makeSidx(sidxVersion, sidxEarliestPresentationTime),
    box('moof', Buffer.concat([mfhd, correctedTraf])),
    box('mdat', Buffer.from('aaabb'))
  ]);
}

describe('AAC priming post-processing', () => {
  it('removes the audio edit list, drops the first sample, and shifts later tfdt', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit(1024));
    await writeFile(join(audioDir, '1.m4s'), makeSegment(0));
    await writeFile(join(audioDir, '2.m4s'), makeSegment(5000));

    await trimAacPrimingSamples(stagingDir);

    const init = await readFile(join(audioDir, 'init.mp4'));
    const firstSegment = await readFile(join(audioDir, '1.m4s'));
    const laterSegment = await readFile(join(audioDir, '2.m4s'));

    expect(init.includes(Buffer.from('edts'))).toBe(false);
    expect(firstSegment.includes(Buffer.from('aaabb'))).toBe(false);
    expect(firstSegment.includes(Buffer.from('bb'))).toBe(true);
    const sidx = firstSegment.indexOf(Buffer.from('sidx'));
    expect(firstSegment.readUInt32BE(sidx + 28)).toBe(989);
    expect(firstSegment.readUInt32BE(sidx + 32)).toBe(1024);
    expect(
      laterSegment.readBigUInt64BE(
        laterSegment.indexOf(Buffer.from('tfdt')) + 8
      )
    ).toBe(3976n);
    expect(
      laterSegment.readUInt32BE(laterSegment.indexOf(Buffer.from('sidx')) + 16)
    ).toBe(3976);
  });

  it('leaves a track without matching priming metadata unchanged', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    const init = makeInit();
    const firstSegment = makeSegment(0);
    await writeFile(join(audioDir, 'init.mp4'), init);
    await writeFile(join(audioDir, '1.m4s'), firstSegment);

    await trimAacPrimingSamples(stagingDir);

    expect(await readFile(join(audioDir, 'init.mp4'))).toEqual(init);
    expect(await readFile(join(audioDir, '1.m4s'))).toEqual(firstSegment);
  });

  it('uses trex default sample duration when trun omits it', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit(1024, 1024));
    await writeFile(join(audioDir, '1.m4s'), makeSegment(0, false));
    await writeFile(join(audioDir, '2.m4s'), makeSegment(5000, false));

    await trimAacPrimingSamples(stagingDir);

    const laterSegment = await readFile(join(audioDir, '2.m4s'));
    expect(
      laterSegment.readBigUInt64BE(
        laterSegment.indexOf(Buffer.from('tfdt')) + 8
      )
    ).toBe(3976n);
  });

  it('shifts version 1 sidx timing with the audio tfdt', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit(1024));
    await writeFile(join(audioDir, '1.m4s'), makeSegment(0));
    await writeFile(join(audioDir, '2.m4s'), makeSegment(5000, true, 1, 5000));

    await trimAacPrimingSamples(stagingDir);

    const laterSegment = await readFile(join(audioDir, '2.m4s'));
    const sidx = laterSegment.indexOf(Buffer.from('sidx'));
    expect(laterSegment.readBigUInt64BE(sidx + 16)).toBe(3976n);
  });

  it('leaves a rendition unchanged when its first segment is unsupported', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit(1024));
    const firstSegment = makeSegment(
      0,
      true,
      0,
      0,
      box('senc', fullBox(0, 0, Buffer.alloc(4)))
    );
    await writeFile(join(audioDir, '1.m4s'), firstSegment);

    await expect(trimAacPrimingSamples(stagingDir)).resolves.toBeUndefined();
    expect(await readFile(join(audioDir, 'init.mp4'))).toEqual(makeInit(1024));
    expect(await readFile(join(audioDir, '1.m4s'))).toEqual(firstSegment);
  });

  it('leaves a rendition unchanged when tfhd uses base_data_offset', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit(1024));
    const firstSegment = makeSegment(0, true, 0, 0, undefined, true);
    await writeFile(join(audioDir, '1.m4s'), firstSegment);

    await expect(trimAacPrimingSamples(stagingDir)).resolves.toBeUndefined();
    expect(await readFile(join(audioDir, 'init.mp4'))).toEqual(makeInit(1024));
    expect(await readFile(join(audioDir, '1.m4s'))).toEqual(firstSegment);
  });

  it('propagates a media write failure instead of treating it as a no-op', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit(1024));
    await writeFile(join(audioDir, '1.m4s'), makeSegment(0));

    mockWriteFailureAfter = 1;
    mockWriteCalls = 0;
    await expect(trimAacPrimingSamples(stagingDir)).rejects.toThrow(
      'AAC priming post-processing write failed'
    );
    mockWriteFailureAfter = -1;
  });
});
