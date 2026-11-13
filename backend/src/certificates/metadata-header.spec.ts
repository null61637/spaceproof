import { BadRequestException } from '@nestjs/common';
import { METADATA_HEADER, parseMetadataHeader } from './metadata-header';

const valid = {
  title: 'Escena de prueba',
  recipient: 'José Pérez',
  satellite: 'Sentinel-2A',
  sensor: 'MSI',
  sceneId: 'S2A_MSIL2A_20260101T140051',
  acquiredAt: '2026-01-01T14:00:51.000Z',
  fileName: 'escena.tif',
};

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** The validation messages of a rejected header, joined. */
async function rejection(header: string | string[] | undefined) {
  try {
    await parseMetadataHeader(header);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const { message } = (error as BadRequestException).getResponse() as {
      message: string | string[];
    };
    return [message].flat().join(' | ');
  }
  throw new Error('expected the header to be rejected');
}

describe('parseMetadataHeader', () => {
  it('uses a dedicated header', () => {
    expect(METADATA_HEADER).toBe('x-spaceproof-metadata');
  });

  it('decodes base64url JSON into validated metadata', async () => {
    const dto = await parseMetadataHeader(encode(valid));
    expect(dto).toEqual({
      ...valid,
      acquiredAt: new Date('2026-01-01T14:00:51.000Z'),
    });
    expect(dto.acquiredAt).toBeInstanceOf(Date);
  });

  it('accepts padded base64url and any Unicode text', async () => {
    const header = Buffer.from(
      JSON.stringify({ ...valid, recipient: 'Ñandú S.A. 衛星 🛰' }),
    )
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_');
    const dto = await parseMetadataHeader(header);
    expect(dto.recipient).toBe('Ñandú S.A. 衛星 🛰');
  });

  it('trims texts and stores them in NFC', async () => {
    const dto = await parseMetadataHeader(
      encode({ ...valid, title: '  T  ', recipient: 'José'.normalize('NFD') }),
    );
    expect(dto.title).toBe('T');
    expect(dto.recipient).toBe('José'.normalize('NFC'));
  });

  it.each([
    ['absent', {}],
    ['null', { sensor: null, sceneId: null }],
    ['empty', { sensor: '', sceneId: '   ' }],
  ])('stores %s optionals as null', async (_label, optionals) => {
    const { title, recipient, satellite, acquiredAt, fileName } = valid;
    const dto = await parseMetadataHeader(
      encode({
        title,
        recipient,
        satellite,
        acquiredAt,
        fileName,
        ...optionals,
      }),
    );
    expect(dto.sensor).toBeNull();
    expect(dto.sceneId).toBeNull();
  });

  it('converts an instant with an offset to the same moment', async () => {
    const dto = await parseMetadataHeader(
      encode({ ...valid, acquiredAt: '2026-01-01T11:00:51-03:00' }),
    );
    expect(dto.acquiredAt.toISOString()).toBe('2026-01-01T14:00:51.000Z');
  });

  it('accepts the file extension in any case', async () => {
    const dto = await parseMetadataHeader(
      encode({ ...valid, fileName: 'ESCENA.TIFF' }),
    );
    expect(dto.fileName).toBe('ESCENA.TIFF');
  });

  it.each<[string, string | string[] | undefined]>([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a repeated header', [encode(valid), encode(valid)]],
    ['standard base64 characters', 'ab+/'],
    ['text that is not base64url', '{"title":"T"}'],
    [
      'bytes that are not UTF-8',
      Buffer.from([0x22, 0xff, 0xfe, 0x22]).toString('base64url'),
    ],
    ['text that is not JSON', Buffer.from('nope').toString('base64url')],
    ['a JSON array', encode([valid])],
    ['a JSON string', encode('title')],
    ['JSON null', encode(null)],
    ['an oversized header', 'A'.repeat(8193)],
  ])('rejects %s', async (_label, header) => {
    await expect(parseMetadataHeader(header)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a missing title', { title: undefined }, 'title'],
    ['a blank recipient', { recipient: '   ' }, 'recipient'],
    ['a missing satellite', { satellite: undefined }, 'satellite'],
    ['a too long title', { title: 'x'.repeat(201) }, 'title'],
    ['a too long sensor', { sensor: 'x'.repeat(201) }, 'sensor'],
    ['a non-text title', { title: 42 }, 'title'],
    ['a non-text sensor', { sensor: { a: 1 } }, 'sensor'],
    ['a control character', { title: 'a\u0000b' }, 'title'],
    ['a line break', { recipient: 'a\nb' }, 'recipient'],
    ['a bidirectional override', { title: 'abc\u202Edef' }, 'title'],
    ['a bidirectional isolate', { sceneId: 'a\u2066b' }, 'sceneId'],
    ['a lone surrogate', { satellite: 'a\ud800b' }, 'satellite'],
    ['a missing acquisition date', { acquiredAt: undefined }, 'acquiredAt'],
    ['a date without time', { acquiredAt: '2026-01-01' }, 'acquiredAt'],
    ['a local time', { acquiredAt: '2026-01-01T14:00:51' }, 'acquiredAt'],
    [
      'a day that does not exist',
      { acquiredAt: '2026-02-30T00:00:00Z' },
      'acquiredAt',
    ],
    [
      'a month that does not exist',
      { acquiredAt: '2026-13-01T00:00:00Z' },
      'acquiredAt',
    ],
    ['a numeric date', { acquiredAt: 1767276051000 }, 'acquiredAt'],
    ['year 0000', { acquiredAt: '0000-06-01T00:00:00Z' }, 'acquiredAt'],
    [
      'a year past 9999 once in UTC',
      { acquiredAt: '9999-12-31T23:59:59-01:00' },
      'acquiredAt',
    ],
    ['a missing file name', { fileName: undefined }, 'fileName'],
    ['another extension', { fileName: 'escena.png' }, 'fileName'],
    ['no extension', { fileName: 'tif' }, 'fileName'],
    [
      'a too long file name',
      { fileName: 'x'.repeat(252) + '.tif' },
      'fileName',
    ],
    ['a client-supplied id', { id: 'x' }, 'id'],
    ['a client-supplied contentHash', { contentHash: 'a' }, 'contentHash'],
    ['a client-supplied fileSha256', { fileSha256: 'a' }, 'fileSha256'],
    ['a client-supplied fileSizeBytes', { fileSizeBytes: 1 }, 'fileSizeBytes'],
    ['a client-supplied createdAt', { createdAt: 'x' }, 'createdAt'],
    ['a client-supplied hashVersion', { hashVersion: 1 }, 'hashVersion'],
    ['a client-supplied txHash', { txHash: '0x1' }, 'txHash'],
  ])('rejects %s', async (_label, change, property) => {
    expect(await rejection(encode({ ...valid, ...change }))).toContain(
      property,
    );
  });

  it('never quotes the submitted values in its error', async () => {
    const message = await rejection(
      encode({ ...valid, title: 'Secret\u0000title', recipient: '' }),
    );
    expect(message).not.toContain('Secret');
  });
});
