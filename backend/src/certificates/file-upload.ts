import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

/** 200 MB. Checked against Content-Length and against the bytes received. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface FileDigest {
  /** SHA-256 of the received bytes: 64 lowercase hex characters. */
  sha256: string;
  sizeBytes: number;
}

/** A request body: the stream plus the headers that announced it. */
export type FileRequest = Readable & { headers: IncomingHttpHeaders };

// Classic TIFF and BigTIFF, little and big endian. This is an entry filter on
// four bytes, not a validation of the format: it says nothing about the file
// being a well-formed TIFF, a GeoTIFF or a COG.
const TIFF_SIGNATURES = ['49492a00', '4d4d002a', '49492b00', '4d4d002b'];
const SIGNATURE_BYTES = 4;

export function hasTiffSignature(head: Buffer): boolean {
  return TIFF_SIGNATURES.includes(
    head.subarray(0, SIGNATURE_BYTES).toString('hex'),
  );
}

const tooLarge = () =>
  new PayloadTooLargeException(`File exceeds ${MAX_FILE_BYTES} bytes`);
const empty = () => new BadRequestException('File is empty');
const notTiff = () =>
  new UnsupportedMediaTypeException('File does not have a TIFF signature');
const interrupted = () => new BadRequestException('Upload interrupted');

/**
 * Reads a request body as a stream and returns its SHA-256 and size. Every
 * chunk is hashed and dropped: nothing is written to disk and memory use does
 * not depend on the file size.
 *
 * Rejects (with the HTTP error to answer) an empty, oversized or interrupted
 * body and, when asked, one without a TIFF signature. A declared
 * Content-Length is checked before reading anything, but never trusted: the
 * bytes are counted as they arrive.
 */
export function receiveFile(
  request: FileRequest,
  options: { requireTiffSignature: boolean; maxBytes?: number },
): Promise<FileDigest> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;

  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      return Promise.reject(new BadRequestException('Invalid Content-Length'));
    }
    const length = Number(declared);
    if (length > maxBytes) return Promise.reject(tooLarge());
    if (length === 0) return Promise.reject(empty());
  }
  // A body someone else already consumed can never be hashed.
  if (request.readableEnded || request.destroyed) {
    return Promise.reject(interrupted());
  }

  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let head = Buffer.alloc(0);
    let signaturePending = options.requireTiffSignature;

    const detach = () => {
      request.off('data', onData).off('end', onEnd).off('close', onClose);
    };
    // Stops reading: the rest of the body is never consumed.
    const stop = (error: Error) => {
      detach();
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) return stop(tooLarge());
      if (signaturePending) {
        head = Buffer.concat([
          head,
          chunk.subarray(0, SIGNATURE_BYTES - head.length),
        ]);
        if (head.length === SIGNATURE_BYTES) {
          signaturePending = false;
          if (!hasTiffSignature(head)) return stop(notTiff());
        }
      }
      hash.update(chunk);
    };
    const onEnd = () => {
      detach();
      if (sizeBytes === 0) return reject(empty());
      // Fewer bytes than a signature.
      if (signaturePending) return reject(notTiff());
      resolve({ sha256: hash.digest('hex'), sizeBytes });
    };
    // The connection closed before the body ended: the partial hash is dropped.
    const onClose = () => {
      detach();
      reject(interrupted());
    };

    request.on('data', onData).on('end', onEnd).on('close', onClose);
    // Stays attached: a late stream error must not crash the process.
    request.on('error', onClose);
  });
}
