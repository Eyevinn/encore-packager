import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AAC_SAMPLES_PER_ACCESS_UNIT = 1024;
const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x000800;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x000010;

type Mp4Box = {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  payload: Buffer;
  raw: Buffer;
};

type TrunSample = {
  duration?: number;
  size?: number;
  flags?: number;
  compositionTimeOffset?: number;
};

type ParsedTrun = {
  version: number;
  flags: number;
  dataOffset?: number;
  firstSampleFlags?: number;
  samples: TrunSample[];
};

type ParsedTfhd = {
  trackId: number;
  defaultSampleSize?: number;
};

function parseBoxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;

  while (offset < end) {
    if (end - offset < 8) {
      throw new Error(`Invalid MP4 box header at offset ${offset}`);
    }

    const declaredSize = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    let size = declaredSize;

    if (declaredSize === 1) {
      if (end - offset < 16) {
        throw new Error(`Invalid extended MP4 box header for ${type}`);
      }
      const extendedSize = Number(buffer.readBigUInt64BE(offset + 8));
      if (!Number.isSafeInteger(extendedSize)) {
        throw new Error(`Unsupported oversized MP4 box ${type}`);
      }
      size = extendedSize;
      headerSize = 16;
    } else if (declaredSize === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
      throw new Error(`Invalid MP4 box size for ${type}`);
    }

    boxes.push({
      type,
      start: offset,
      size,
      headerSize,
      payload: buffer.subarray(offset + headerSize, offset + size),
      raw: buffer.subarray(offset, offset + size)
    });
    offset += size;
  }

  return boxes;
}

function encodeBox(type: string, payload: Buffer): Buffer {
  const size = payload.length + 8;
  if (size > 0xffffffff) {
    const result = Buffer.alloc(16 + payload.length);
    result.writeUInt32BE(1, 0);
    result.write(type, 4, 4, 'ascii');
    result.writeBigUInt64BE(BigInt(result.length), 8);
    payload.copy(result, 16);
    return result;
  }

  const result = Buffer.alloc(size);
  result.writeUInt32BE(size, 0);
  result.write(type, 4, 4, 'ascii');
  payload.copy(result, 8);
  return result;
}

function serializeBox(box: Mp4Box): Buffer {
  return box.raw;
}

function replaceChildren(box: Mp4Box, children: Buffer[]): Buffer {
  return encodeBox(box.type, Buffer.concat(children));
}

function fullBoxVersion(payload: Buffer): number {
  if (payload.length < 4) {
    throw new Error('Invalid full MP4 box');
  }
  return payload[0];
}

function fullBoxFlags(payload: Buffer): number {
  if (payload.length < 4) {
    throw new Error('Invalid full MP4 box');
  }
  return payload.readUIntBE(1, 3);
}

function readTfhd(box: Mp4Box): ParsedTfhd {
  const flags = fullBoxFlags(box.payload);
  if (box.payload.length < 8) {
    throw new Error('Invalid tfhd box');
  }

  let offset = 8;
  const result: ParsedTfhd = {
    trackId: box.payload.readUInt32BE(4)
  };

  if (flags & 0x000001) offset += 8;
  if (flags & 0x000002) offset += 4;
  if (flags & 0x000008) offset += 4;
  if (flags & TFHD_DEFAULT_SAMPLE_SIZE_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid tfhd default sample size');
    }
    result.defaultSampleSize = box.payload.readUInt32BE(offset);
  }

  return result;
}

function readTrun(box: Mp4Box): ParsedTrun {
  const version = fullBoxVersion(box.payload);
  const flags = fullBoxFlags(box.payload);
  if (box.payload.length < 8) {
    throw new Error('Invalid trun box');
  }

  let offset = 8;
  const sampleCount = box.payload.readUInt32BE(4);
  const result: ParsedTrun = { version, flags, samples: [] };

  if (flags & TRUN_DATA_OFFSET_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid trun data offset');
    }
    result.dataOffset = box.payload.readInt32BE(offset);
    offset += 4;
  }
  if (flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) {
    if (box.payload.length < offset + 4) {
      throw new Error('Invalid trun first sample flags');
    }
    result.firstSampleFlags = box.payload.readUInt32BE(offset);
    offset += 4;
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const sample: TrunSample = {};
    if (flags & TRUN_SAMPLE_DURATION_PRESENT) {
      sample.duration = readUInt32(box.payload, offset, 'trun sample duration');
      offset += 4;
    }
    if (flags & TRUN_SAMPLE_SIZE_PRESENT) {
      sample.size = readUInt32(box.payload, offset, 'trun sample size');
      offset += 4;
    }
    if (flags & TRUN_SAMPLE_FLAGS_PRESENT) {
      sample.flags = readUInt32(box.payload, offset, 'trun sample flags');
      offset += 4;
    }
    if (flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT) {
      sample.compositionTimeOffset =
        version === 1
          ? readInt32(box.payload, offset, 'trun composition offset')
          : readUInt32(box.payload, offset, 'trun composition offset');
      offset += 4;
    }
    result.samples.push(sample);
  }

  if (offset !== box.payload.length) {
    throw new Error('Unexpected data in trun box');
  }
  return result;
}

function writeUInt32(value: number, label: string): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value, 0);
  return result;
}

function writeInt32(value: number, label: string): Buffer {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  const result = Buffer.alloc(4);
  result.writeInt32BE(value, 0);
  return result;
}

function readUInt32(buffer: Buffer, offset: number, label: string): number {
  if (buffer.length < offset + 4) throw new Error(`Invalid ${label}`);
  return buffer.readUInt32BE(offset);
}

function readInt32(buffer: Buffer, offset: number, label: string): number {
  if (buffer.length < offset + 4) throw new Error(`Invalid ${label}`);
  return buffer.readInt32BE(offset);
}

function writeTrun(parsed: ParsedTrun): Buffer {
  const chunks: Buffer[] = [];
  const versionAndFlags = Buffer.alloc(4);
  versionAndFlags[0] = parsed.version;
  versionAndFlags.writeUIntBE(parsed.flags, 1, 3);
  chunks.push(
    versionAndFlags,
    writeUInt32(parsed.samples.length, 'trun sample count')
  );

  if (parsed.flags & TRUN_DATA_OFFSET_PRESENT) {
    chunks.push(writeInt32(parsed.dataOffset || 0, 'trun data offset'));
  }
  if (parsed.flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) {
    chunks.push(
      writeUInt32(parsed.firstSampleFlags || 0, 'trun first sample flags')
    );
  }

  for (const sample of parsed.samples) {
    if (parsed.flags & TRUN_SAMPLE_DURATION_PRESENT) {
      chunks.push(writeUInt32(sample.duration || 0, 'trun sample duration'));
    }
    if (parsed.flags & TRUN_SAMPLE_SIZE_PRESENT) {
      chunks.push(writeUInt32(sample.size || 0, 'trun sample size'));
    }
    if (parsed.flags & TRUN_SAMPLE_FLAGS_PRESENT) {
      chunks.push(writeUInt32(sample.flags || 0, 'trun sample flags'));
    }
    if (parsed.flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT) {
      chunks.push(
        parsed.version === 1
          ? writeInt32(
              sample.compositionTimeOffset || 0,
              'trun composition offset'
            )
          : writeUInt32(
              sample.compositionTimeOffset || 0,
              'trun composition offset'
            )
      );
    }
  }

  return encodeBox('trun', Buffer.concat(chunks));
}

function findChild(box: Mp4Box, type: string): Mp4Box | undefined {
  return parseBoxes(box.payload).find((child) => child.type === type);
}

function readTrackId(trak: Mp4Box): number | undefined {
  const tkhd = findChild(trak, 'tkhd');
  if (!tkhd) return undefined;
  const version = fullBoxVersion(tkhd.payload);
  const offset = version === 1 ? 20 : 12;
  if (tkhd.payload.length < offset + 4) return undefined;
  return tkhd.payload.readUInt32BE(offset);
}

function isAudioTrack(trak: Mp4Box): boolean {
  const mdia = findChild(trak, 'mdia');
  const hdlr = mdia && findChild(mdia, 'hdlr');
  return Boolean(
    hdlr &&
      hdlr.payload.length >= 12 &&
      hdlr.payload.toString('ascii', 8, 12) === 'soun'
  );
}

function removeAudioEditList(buffer: Buffer): {
  buffer: Buffer;
  audioTrackId: number;
} {
  const topLevel = parseBoxes(buffer);
  const moov = topLevel.find((box) => box.type === 'moov');
  if (!moov) throw new Error('MP4 init segment has no moov box');

  let audioTrackId: number | undefined;
  const moovChildren = parseBoxes(moov.payload);
  const transformedMoovChildren = moovChildren.map((child) => {
    if (child.type !== 'trak' || !isAudioTrack(child))
      return serializeBox(child);

    const trackId = readTrackId(child);
    if (trackId === undefined) {
      throw new Error('Audio track has no track ID');
    }
    audioTrackId = trackId;

    const trakChildren = parseBoxes(child.payload).filter(
      (trakChild) => trakChild.type !== 'edts'
    );
    return replaceChildren(
      child,
      trakChildren.map((trakChild) => serializeBox(trakChild))
    );
  });

  if (audioTrackId === undefined) {
    throw new Error('MP4 init segment has no audio track');
  }

  const transformedMoov = replaceChildren(moov, transformedMoovChildren);
  const transformedTopLevel = topLevel.map((box) =>
    box === moov ? transformedMoov : serializeBox(box)
  );
  return { buffer: Buffer.concat(transformedTopLevel), audioTrackId };
}

function rewriteAudioTrun(
  moof: Mp4Box,
  audioTrackId: number,
  removeFirstSample: boolean
): { buffer: Buffer; removedSampleSize?: number; dataOffset?: number } {
  let removed = false;
  let removedSampleSize: number | undefined;
  let originalDataOffset: number | undefined;

  const transformedTraf = parseBoxes(moof.payload).map((child) => {
    if (child.type !== 'traf') return serializeBox(child);
    const trafChildren = parseBoxes(child.payload);
    const tfhdBox = trafChildren.find((trafChild) => trafChild.type === 'tfhd');
    if (!tfhdBox || readTfhd(tfhdBox).trackId !== audioTrackId) {
      return serializeBox(child);
    }

    const tfhd = readTfhd(tfhdBox);
    const transformedTrun = trafChildren.map((trafChild) => {
      if (trafChild.type !== 'trun' || removed || !removeFirstSample) {
        return serializeBox(trafChild);
      }

      const trun = readTrun(trafChild);
      if (trun.samples.length === 0) return serializeBox(trafChild);

      const firstSample = trun.samples[0];
      removedSampleSize = firstSample.size ?? tfhd.defaultSampleSize;
      if (removedSampleSize === undefined) {
        throw new Error('Cannot determine the first AAC sample size');
      }
      if (removedSampleSize === 0) {
        throw new Error('The first AAC sample has zero size');
      }
      if (trun.dataOffset === undefined) {
        throw new Error('Cannot trim an audio trun without data_offset');
      }

      originalDataOffset = trun.dataOffset;
      trun.samples.shift();
      trun.flags &= ~TRUN_FIRST_SAMPLE_FLAGS_PRESENT;
      trun.firstSampleFlags = undefined;
      removed = true;
      return writeTrun(trun);
    });

    return replaceChildren(child, transformedTrun);
  });

  if (removeFirstSample && !removed) {
    throw new Error('Audio segment 1 has no AAC samples to trim');
  }

  return {
    buffer: replaceChildren(moof, transformedTraf),
    removedSampleSize,
    dataOffset: originalDataOffset
  };
}

function adjustTrunDataOffsets(moofBuffer: Buffer, delta: number): Buffer {
  const moof = parseBoxes(moofBuffer)[0];
  const transformedTraf = parseBoxes(moof.payload).map((child) => {
    if (child.type !== 'traf') return serializeBox(child);
    const transformed = parseBoxes(child.payload).map((trafChild) => {
      if (trafChild.type !== 'trun') return serializeBox(trafChild);
      const trun = readTrun(trafChild);
      if (trun.dataOffset !== undefined) trun.dataOffset += delta;
      return trun.dataOffset === undefined
        ? serializeBox(trafChild)
        : writeTrun(trun);
    });
    return replaceChildren(child, transformed);
  });
  return replaceChildren(moof, transformedTraf);
}

function adjustFirstSidx(
  box: Mp4Box,
  referencedSizeDelta: number,
  durationDelta: number
): Buffer {
  const version = fullBoxVersion(box.payload);
  let offset = 12;
  offset += version === 1 ? 8 : 4;
  offset += 8;
  offset += 2;
  if (box.payload.length < offset + 2) {
    throw new Error('Invalid sidx box');
  }

  const referenceCount = box.payload.readUInt16BE(offset);
  offset += 2;
  if (referenceCount === 0 || box.payload.length < offset + 12) {
    return box.raw;
  }

  const reference = box.payload.readUInt32BE(offset);
  if (reference & 0x80000000) {
    return box.raw;
  }

  const referencedSize = reference & 0x7fffffff;
  const nextReferencedSize = referencedSize + referencedSizeDelta;
  const nextDuration = box.payload.readUInt32BE(offset + 4) + durationDelta;
  if (
    nextReferencedSize < 0 ||
    nextReferencedSize > 0x7fffffff ||
    nextDuration < 0 ||
    nextDuration > 0xffffffff
  ) {
    throw new Error('Invalid adjusted sidx values');
  }

  const payload = Buffer.from(box.payload);
  payload.writeUInt32BE(nextReferencedSize, offset);
  payload.writeUInt32BE(nextDuration, offset + 4);
  return encodeBox('sidx', payload);
}

function shiftAudioTfdt(buffer: Buffer, audioTrackId: number): Buffer {
  const topLevel = parseBoxes(buffer);
  const moof = topLevel.find((box) => box.type === 'moof');
  if (!moof) throw new Error('Audio media segment has no moof box');

  let shifted = false;
  const transformedTraf = parseBoxes(moof.payload).map((child) => {
    if (child.type !== 'traf') return serializeBox(child);
    const trafChildren = parseBoxes(child.payload);
    const tfhdBox = trafChildren.find((trafChild) => trafChild.type === 'tfhd');
    if (!tfhdBox || readTfhd(tfhdBox).trackId !== audioTrackId) {
      return serializeBox(child);
    }

    const transformed = trafChildren.map((trafChild) => {
      if (trafChild.type !== 'tfdt') return serializeBox(trafChild);
      const version = fullBoxVersion(trafChild.payload);
      const offset = 4;
      const current =
        version === 1
          ? Number(trafChild.payload.readBigUInt64BE(offset))
          : trafChild.payload.readUInt32BE(offset);
      if (current < AAC_SAMPLES_PER_ACCESS_UNIT) {
        throw new Error('Cannot move audio tfdt before zero');
      }
      const next = current - AAC_SAMPLES_PER_ACCESS_UNIT;
      const payload = Buffer.from(trafChild.payload);
      if (version === 1) {
        payload.writeBigUInt64BE(BigInt(next), offset);
      } else {
        payload.writeUInt32BE(next, offset);
      }
      shifted = true;
      return encodeBox('tfdt', payload);
    });
    return replaceChildren(child, transformed);
  });

  if (!shifted) throw new Error('Audio media segment has no tfdt box');
  const transformedMoof = replaceChildren(moof, transformedTraf);
  return Buffer.concat(
    topLevel.map((box) => (box === moof ? transformedMoof : serializeBox(box)))
  );
}

function trimFirstAudioSample(buffer: Buffer, audioTrackId: number): Buffer {
  const topLevel = parseBoxes(buffer);
  const moof = topLevel.find((box) => box.type === 'moof');
  if (!moof) throw new Error('Audio media segment has no moof box');

  const rewritten = rewriteAudioTrun(moof, audioTrackId, true);
  if (
    rewritten.removedSampleSize === undefined ||
    rewritten.dataOffset === undefined
  ) {
    throw new Error('Failed to identify the first AAC sample');
  }
  const removedSampleSize = rewritten.removedSampleSize;
  const dataOffset = rewritten.dataOffset;

  const oldMoofSize = moof.size;
  const newMoofSize = rewritten.buffer.length;
  const delta = newMoofSize - oldMoofSize;
  const transformedMoof = adjustTrunDataOffsets(rewritten.buffer, delta);
  const sampleAbsoluteOffset = moof.start + dataOffset;
  let removedFromMdat = false;
  let adjustedSidx = false;

  const transformedTopLevel = topLevel.map((box) => {
    if (box === moof) return transformedMoof;
    if (box.type === 'sidx' && !adjustedSidx) {
      adjustedSidx = true;
      return adjustFirstSidx(
        box,
        delta - removedSampleSize,
        -AAC_SAMPLES_PER_ACCESS_UNIT
      );
    }
    if (box.type !== 'mdat') return serializeBox(box);

    const sampleOffsetInMdat =
      sampleAbsoluteOffset - box.start - box.headerSize;
    if (
      !removedFromMdat &&
      sampleOffsetInMdat >= 0 &&
      sampleOffsetInMdat + removedSampleSize <= box.payload.length
    ) {
      removedFromMdat = true;
      const payload = Buffer.concat([
        box.payload.subarray(0, sampleOffsetInMdat),
        box.payload.subarray(sampleOffsetInMdat + removedSampleSize)
      ]);
      return encodeBox('mdat', payload);
    }
    return serializeBox(box);
  });

  if (!removedFromMdat) {
    throw new Error('The first AAC sample is not present in an mdat box');
  }
  return Buffer.concat(transformedTopLevel);
}

function segmentNumber(filename: string): number {
  const match = /^(\d+)\.m4s$/.exec(filename);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export async function trimAacPrimingSamples(stagingDir: string): Promise<void> {
  const audioDir = join(stagingDir, 'audio');
  try {
    await stat(audioDir);
  } catch {
    return;
  }

  const initPath = join(audioDir, 'init.mp4');
  try {
    await stat(initPath);
  } catch {
    return;
  }

  const init = await removeAudioEditList(await readFile(initPath));
  await writeFile(initPath, init.buffer);

  const segmentFiles = (await readdir(audioDir)).filter((file) =>
    file.endsWith('.m4s')
  );
  segmentFiles.sort(
    (left, right) => segmentNumber(left) - segmentNumber(right)
  );
  if (segmentFiles.length === 0) return;

  const firstSegment = join(audioDir, segmentFiles[0]);
  await writeFile(
    firstSegment,
    trimFirstAudioSample(await readFile(firstSegment), init.audioTrackId)
  );

  for (const segment of segmentFiles.slice(1)) {
    const path = join(audioDir, segment);
    await writeFile(
      path,
      shiftAudioTfdt(await readFile(path), init.audioTrackId)
    );
  }
}
