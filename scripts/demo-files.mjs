// Generates the two files of the SpaceProof demo, always byte for byte the
// same (no randomness, no dates):
//
//   demo/escena-demo.tif           a valid 512x512 greyscale TIFF: a
//                                  SYNTHETIC scene, not satellite data
//   demo/escena-demo-alterada.tif  the same file with ONE bit changed
//
//   node scripts/demo-files.mjs
//
// No dependencies. The files are not committed (demo/ is ignored).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const WIDTH = 512;
const HEIGHT = 512;

// Deterministic "terrain": smooth bands, a river-like curve and fine grain.
const pixels = Buffer.alloc(WIDTH * HEIGHT);
let seed = 0x5eed;
const grain = () => {
  // xorshift16: fixed sequence.
  seed ^= (seed << 7) & 0xffff;
  seed ^= seed >> 9;
  seed ^= (seed << 8) & 0xffff;
  return seed & 0x0f;
};
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const relief =
      96 +
      48 * Math.sin(x / 61) * Math.cos(y / 47) +
      32 * Math.sin((x + y) / 23);
    const river = Math.abs(y - (256 + 90 * Math.sin(x / 80))) < 5 ? -70 : 0;
    pixels[y * WIDTH + x] = Math.max(
      0,
      Math.min(255, Math.round(relief + river + grain())),
    );
  }
}

// Baseline TIFF, little-endian, one uncompressed strip.
const ENTRIES = [
  [256, 4, WIDTH], // ImageWidth
  [257, 4, HEIGHT], // ImageLength
  [258, 3, 8], // BitsPerSample
  [259, 3, 1], // Compression: none
  [262, 3, 1], // PhotometricInterpretation: BlackIsZero
  [273, 4, 0], // StripOffsets (filled in below)
  [277, 3, 1], // SamplesPerPixel
  [278, 4, HEIGHT], // RowsPerStrip
  [279, 4, pixels.length], // StripByteCounts
];
const ifdSize = 2 + ENTRIES.length * 12 + 4;
const dataOffset = 8 + ifdSize;
ENTRIES[5][2] = dataOffset;

const header = Buffer.alloc(dataOffset);
header.write("II", 0, "ascii");
header.writeUInt16LE(42, 2);
header.writeUInt32LE(8, 4);
header.writeUInt16LE(ENTRIES.length, 8);
ENTRIES.forEach(([tag, type, value], i) => {
  const at = 10 + i * 12;
  header.writeUInt16LE(tag, at);
  header.writeUInt16LE(type, at + 2);
  header.writeUInt32LE(1, at + 4);
  if (type === 3) header.writeUInt16LE(value, at + 8);
  else header.writeUInt32LE(value, at + 8);
});

const original = Buffer.concat([header, pixels]);
// One bit of one pixel in the middle of the image: invisible to the eye.
const altered = Buffer.from(original);
const changedAt = dataOffset + (HEIGHT / 2) * WIDTH + WIDTH / 2;
altered[changedAt] ^= 0x01;

mkdirSync("demo", { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, bytes] of [
  ["demo/escena-demo.tif", original],
  ["demo/escena-demo-alterada.tif", altered],
]) {
  writeFileSync(name, bytes);
  console.log(`${name}  ${bytes.length} bytes  sha256 ${sha256(bytes)}`);
}
console.log(`The two files differ in one bit, at byte ${changedAt}.`);
