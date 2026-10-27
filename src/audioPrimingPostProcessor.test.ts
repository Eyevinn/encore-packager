import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trimAacPrimingSamples } from './audioPrimingPostProcessor';

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

function makeInit(): Buffer {
  const tkhd = Buffer.alloc(12);
  tkhd.writeUInt32BE(7, 8);
  const hdlr = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('soun'),
    Buffer.alloc(8)
  ]);
  const mdia = box(
    'mdia',
    Buffer.concat([
      box('hdlr', fullBox(0, 0, hdlr)),
      box('mdhd', Buffer.alloc(8))
    ])
  );
  const editList = box('edts', box('elst', Buffer.alloc(8)));
  const trak = box(
    'trak',
    Buffer.concat([box('tkhd', fullBox(0, 0, tkhd)), editList, mdia])
  );
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', trak)]);
}

function makeTfhd(): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(7, 0);
  return box('tfhd', fullBox(0, 0x000010, payload));
}

function makeTfdt(value: number): Buffer {
  const payload = Buffer.alloc(12);
  payload.writeBigUInt64BE(BigInt(value), 0);
  return box('tfdt', fullBox(1, 0, payload.subarray(0, 12)));
}

function makeTrun(dataOffset: number): Buffer {
  const payload = Buffer.alloc(8 + 16);
  payload.writeUInt32BE(2, 0);
  payload.writeInt32BE(dataOffset, 4);
  payload.writeUInt32BE(1024, 8);
  payload.writeUInt32BE(3, 12);
  payload.writeUInt32BE(1024, 16);
  payload.writeUInt32BE(2, 20);
  return box('trun', fullBox(0, 0x000301, payload));
}

function makeSidx(): Buffer {
  const payload = Buffer.alloc(40);
  payload.writeUInt32BE(1, 0);
  payload.writeUInt32BE(48000, 4);
  payload.writeBigUInt64BE(0n, 8);
  payload.writeBigUInt64BE(0n, 16);
  payload.writeUInt16BE(1, 26);
  payload.writeUInt32BE(1000, 28);
  payload.writeUInt32BE(4096, 32);
  return box('sidx', fullBox(1, 0, payload));
}

function makeSegment(tfdt: number): Buffer {
  const mfhd = box('mfhd', fullBox(0, 0, Buffer.alloc(4)));
  const trafWithPlaceholder = box(
    'traf',
    Buffer.concat([makeTfhd(), makeTfdt(tfdt), makeTrun(0)])
  );
  const dataOffset =
    box('moof', Buffer.concat([mfhd, trafWithPlaceholder])).length + 8;
  const correctedTraf = box(
    'traf',
    Buffer.concat([makeTfhd(), makeTfdt(tfdt), makeTrun(dataOffset)])
  );
  return Buffer.concat([
    makeSidx(),
    box('moof', Buffer.concat([mfhd, correctedTraf])),
    box('mdat', Buffer.from('aaabb'))
  ]);
}

describe('AAC priming post-processing', () => {
  it('removes the audio edit list, drops the first sample, and shifts later tfdt', async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), 'encore-packager-test-'));
    const audioDir = join(stagingDir, 'audio');
    await mkdir(audioDir);
    await writeFile(join(audioDir, 'init.mp4'), makeInit());
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
    expect(firstSegment.readUInt32BE(sidx + 36)).toBe(989);
    expect(firstSegment.readUInt32BE(sidx + 40)).toBe(3072);
    expect(
      laterSegment.readBigUInt64BE(
        laterSegment.indexOf(Buffer.from('tfdt')) + 8
      )
    ).toBe(3976n);
  });
});
