import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  FileRequest,
  MAX_FILE_BYTES,
  hasTiffSignature,
  receiveFile,
} from './file-upload';

const TIFF_LE = Buffer.from('49492a00', 'hex');

function body(
  chunks: Buffer[],
  headers: Record<string, string> = {},
): FileRequest {
  return Object.assign(Readable.from(chunks, { objectMode: false }), {
    headers,
  });
}

/** A body that never ends; counts how many chunks were pulled from it. */
function endless(chunk: Buffer) {
  const state = { produced: 0 };
  const stream = new Readable({
    read() {
      state.produced++;
      this.push(chunk);
    },
  });
  return { state, request: Object.assign(stream, { headers: {} }) };
}

const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('hasTiffSignature', () => {
  it.each(['49492a00', '4d4d002a', '49492b00', '4d4d002b'])(
    'accepts %s',
    (hex) => {
      expect(hasTiffSignature(Buffer.from(hex + 'ffff', 'hex'))).toBe(true);
    },
  );

  it.each([
    ['PNG', '89504e47'],
    ['JPEG', 'ffd8ffe0'],
    ['a wrong version byte', '49492a01'],
    ['a swapped magic number', '4949002a'],
    ['too few bytes', '49492a'],
    ['no bytes', ''],
  ])('rejects %s', (_label, hex) => {
    expect(hasTiffSignature(Buffer.from(hex, 'hex'))).toBe(false);
  });
});

describe('receiveFile', () => {
  const tiff = { requireTiffSignature: true };
  const any = { requireTiffSignature: false };

  it('is limited to 200 MB', () => {
    expect(MAX_FILE_BYTES).toBe(209715200);
  });

  it('returns the SHA-256 and size of the whole body, across chunks', async () => {
    const chunks = [TIFF_LE, Buffer.from('abc'), Buffer.alloc(70000, 7)];
    const whole = Buffer.concat(chunks);
    await expect(receiveFile(body(chunks), tiff)).resolves.toEqual({
      sha256: sha256(whole),
      sizeBytes: whole.length,
    });
  });

  it('matches a known SHA-256 vector', async () => {
    // sha256("abc"), FIPS 180-2.
    const digest = await receiveFile(body([Buffer.from('abc')]), any);
    expect(digest).toEqual({
      sha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sizeBytes: 3,
    });
  });

  it('finds a signature split across chunks', async () => {
    const chunks = [...TIFF_LE].map((byte) => Buffer.from([byte]));
    const digest = await receiveFile(body([...chunks, Buffer.from('x')]), tiff);
    expect(digest.sizeBytes).toBe(5);
  });

  it.each([
    ['another format', [Buffer.from('89504e470d0a1a0a', 'hex')]],
    [
      'a wrong signature split across chunks',
      [Buffer.from('4949', 'hex'), Buffer.from('zz')],
    ],
    ['fewer bytes than a signature', [Buffer.from('4949', 'hex')]],
  ])('rejects %s with 415', async (_label, chunks) => {
    await expect(receiveFile(body(chunks), tiff)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
  });

  it('does not look at the signature unless asked', async () => {
    const digest = await receiveFile(body([Buffer.from('not a tiff')]), any);
    expect(digest.sizeBytes).toBe(10);
  });

  it('stops reading as soon as the signature is wrong', async () => {
    const { state, request } = endless(Buffer.alloc(1024, 1));
    await expect(receiveFile(request, tiff)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    const afterRejection = state.produced;
    await tick();
    expect(state.produced).toBe(afterRejection);
    request.destroy();
  });

  describe('size limit', () => {
    const limit = { requireTiffSignature: false, maxBytes: 10 };

    it('accepts exactly the limit', async () => {
      const digest = await receiveFile(body([Buffer.alloc(10)]), limit);
      expect(digest.sizeBytes).toBe(10);
    });

    it('rejects one byte over the limit, counted while streaming', async () => {
      await expect(
        receiveFile(body([Buffer.alloc(6), Buffer.alloc(5)]), limit),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('rejects a Content-Length over the limit without reading the body', async () => {
      const request = body([Buffer.alloc(11)], { 'content-length': '11' });
      const listen = jest.spyOn(request, 'on');
      await expect(receiveFile(request, limit)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      expect(listen).not.toHaveBeenCalled();
    });

    it('does not trust a Content-Length that understates the body', async () => {
      const request = body([Buffer.alloc(11)], { 'content-length': '5' });
      await expect(receiveFile(request, limit)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });

    it('stops reading an endless body at the limit', async () => {
      const { state, request } = endless(Buffer.alloc(4));
      await expect(receiveFile(request, limit)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
      const afterRejection = state.produced;
      await tick();
      expect(state.produced).toBe(afterRejection);
      request.destroy();
    });
  });

  it.each(['abc', '-1', '1.5', '1e3', ' 10', '0x10'])(
    'rejects the malformed Content-Length %p with 400',
    async (value) => {
      await expect(
        receiveFile(body([TIFF_LE], { 'content-length': value }), tiff),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each([
    ['declared by Content-Length', { 'content-length': '0' }],
    ['found while streaming', {}],
  ])('rejects an empty file %s with 400', async (_label, headers) => {
    await expect(receiveFile(body([], headers), tiff)).rejects.toThrow(
      'File is empty',
    );
  });

  it('rejects an upload interrupted mid-stream, with no digest', async () => {
    const request = Object.assign(new Readable({ read() {} }), { headers: {} });
    const pending = receiveFile(request, tiff);
    request.push(TIFF_LE);
    request.push(Buffer.alloc(1000));
    await tick();
    request.destroy(new Error('socket hang up'));
    await expect(pending).rejects.toThrow('Upload interrupted');
  });

  it('rejects a body that was already consumed instead of waiting forever', async () => {
    const request = body([TIFF_LE]);
    request.resume();
    await new Promise((resolve) => request.once('end', resolve));
    await expect(receiveFile(request, tiff)).rejects.toThrow(
      'Upload interrupted',
    );
  });
});
