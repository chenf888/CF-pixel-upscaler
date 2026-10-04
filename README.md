# CF-pixel-upscaler

A Node.js integer-multiple **pixel replication upscaling** (nearest-neighbor) command-line tool.

The upscaling method is essentially "replicating a single pixel multiple times": when a `100x200` image is upscaled with `scale=2`, it becomes `200x400`, and each original pixel becomes an identical `2x2` pixel block in the output.

- By default, it uses the **hand-written `manual` pixel replication engine** (the main implementation, explicitly copying pixels and not relying on `sharp.resize` for core upscaling).
- `sharp-nearest` serves as an optional fast path and performance comparison baseline (`sharp.resize({ kernel: 'nearest' })`).
- Multi-core parallelism (`worker_threads`), SharedArrayBuffer zero-copy, streaming writes to temporary raw, real-time progress bar.
- Correctness first, followed by multi-core performance, memory safety, and progress feedback.

---

## Tech Stack

| Dependency | Purpose |
| --- | --- |
| `sharp` | Image metadata reading, decoding to raw RGBA, final encoding (JPEG/WebP) |
| `worker_threads` | Multi-core parallelism (this tool uses raw `worker_threads` rather than `piscina` to precisely control SharedArrayBuffer zero-copy, transferable, and out-of-order chunk reassembly; see "Principles") |
| `commander` | CLI argument parsing |
| `cli-progress` | Real-time progress bar |
| `vitest` | Testing |

> Jimp is not used (insufficient performance).

Node.js version requirement: `>= 20`.

---

## Installation and Build

```bash
npm install
npm run build       # Compile TypeScript to dist/
```

Build artifact: `dist/cli.js` (executable entry point, `bin` points to `pixel-upscaler`).

## Testing

```bash
npm test            # vitest run
```

---

## Usage Examples

```bash
# Basic usage: scale=2 (default manual engine)
node dist/cli.js -i input.png -o output.png -s 2

# Specify scale
node dist/cli.js -i input.png -o out.png -s 4

# Specify number of workers
node dist/cli.js -i input.png -o out.png -s 4 -w 8

# Output JPEG / WebP (automatically detected by extension, or specify with --format)
node dist/cli.js -i input.png -o out.jpg -s 2 --quality 85
node dist/cli.js -i input.png -o out.webp -s 2 --quality 85

# Use sharp fast path
node dist/cli.js -i input.png -o out.png -s 3 --engine sharp-nearest

# Performance comparison mode: run manual and sharp-nearest separately, output time/throughput/peak memory and verify pixel consistency
node dist/cli.js -i input.png -o out.png -s 3 --compare

# Overwrite existing output, allow exceeding safety threshold
node dist/cli.js -i input.png -o out.png -s 3 --overwrite --force

# Very large images (e.g., 32000x32000 or larger): streaming processing, no loading the whole image into memory, no GB-level temporary files
#   - PNG uses streaming encoding; only the compressed small file exists on disk (the huge pixel count appears only upon decompression)
#   - The sharp-nearest engine uses libvips for streaming reads/writes, with memory usage decoupled from output size
node dist/cli.js -i big.png -o big_x2.png -s 2 -w 1 --max-output-pixels 20000000000 --force
```

### All Parameters

| Parameter | Short | Default | Description |
| --- | --- | --- | --- |
| `--input` | `-i` | Required | Input image path |
| `--output` | `-o` | Required | Output image path |
| `--scale` | `-s` | `2` | Scale factor (positive integer) |
| `--workers` | `-w` | Number of CPU logical cores | Number of workers |
| `--chunk-rows` | | Auto | Number of input rows processed per task (0 = auto) |
| `--format` | | By extension | `png` \| `jpeg` \| `webp` |
| `--quality` | | `90` | JPEG/WebP quality (1-100) |
| `--max-output-pixels` | | `1e9` | Output pixel safety threshold; rejected if exceeded |
| `--force` | | Off | Allow exceeding safety threshold / memory and disk limits (will warn) |
| `--temp-dir` | | System temp directory | Temporary directory |
| `--overwrite` | | Off | Allow overwriting an existing output file |
| `--keep-metadata` | | Off | Preserve EXIF/ICC where possible (sharp-nearest engine only) |
| `--engine` | | `manual` | `manual` \| `sharp-nearest` \| `auto` |
| `--compare` | | Off | Performance comparison between manual and sharp-nearest |
| `--no-progress` | | Off | Disable progress bar |

---

## Output Size and Safety Checks

- `outWidth = inWidth * scale`, `outHeight = inHeight * scale`; all are calculated with `BigInt` and aligned to `Number.MAX_SAFE_INTEGER`.
- Check per-side limits for each format: PNG `2^31-1`, JPEG `65535`, WebP `16383`.
- Check remaining disk space (`fs.statfs`, skipped if unavailable) and available memory.
- If `--max-output-pixels` is exceeded and `--force` is not specified, exit with an error and provide a message in Chinese along with an exit code.

---

## Core Algorithm (manual hand-written engine)

`src/engines/manual.ts` explicitly implements pixel replication:

```ts
// For each input row, first perform horizontal upscaling: repeat each pixel scale times to construct one output row
for (let x = 0; x < srcWidth; x++) {
  const r = src[sp], g = src[sp+1], b = src[sp+2], a = src[sp+3];
  for (let k = 0; k < scale; k++)
    expandedRow[(x*scale + k)*4] = r/a/g/b ...; // repeat each pixel scale times
}
// Then perform vertical upscaling: repeat this output row scale times
for (let k = 0; k < scale; k++)
  out.set(expandedRow, base + k * outRowBytes); // repeat the row scale times
```

This is completely equivalent to `out[outY][outX] = src[floor(outY/scale)][floor(outX/scale)]`, and is **byte-exact replication**, without any interpolation, filtering, or color management (by default, raw pixels are copied directly, keeping sRGB values unchanged).

---

## Multi-core Parallelism and Memory Safety

- Input raw pixels are placed in a `SharedArrayBuffer`, shared by all workers with zero copy, so the input is not copied repeatedly.
- Chunk by input rows: task `i` processes `[startSrcY, endSrcY)` and generates output rows `[startSrcY*scale, endSrcY*scale)`.
- Workers return **numbered** output buffers (ownership transferred via `transferable`, zero copy). The main thread writes them to a temporary raw file in sequence order; out-of-order completed chunks are cached first, and **the number of in-flight tasks = number of workers**, avoiding memory explosion.
- The main thread only handles scheduling, sequential disk writes, and the progress bar; it does not perform heavy computation.
- **Small images automatically fall back to single-threaded mode** (output pixels < 1 million and `--workers` not explicitly specified) to avoid worker startup overhead.
- The full upscaled image is never generated all at once: the upscaled raw data is streamed to a temporary file in chunks, and finally encoded to the target format by sharp (JPEG/WebP) or the custom streaming PNG encoder. Temporary files are cleaned up on SIGINT or exit.

---

## Image Formats and Streaming Encoding

- **PNG**: Recommended, lossless, supports alpha. Uses a custom streaming PNG encoder (`src/utils/png.ts`: zlib deflate + hand-written PNG chunks), encodes row by row in a streaming manner, and memory usage is independent of output size. In the PNG + `--force` scenario, the manual engine feeds the upscaled result directly into the PNG compression stream, skipping the temporary raw file, so even for very large images it does not produce GB-level temporary files; only the compressed small file exists on disk.
- **JPEG**: Does not support alpha; alpha is composited onto a white background before encoding; maximum width/height is 65535.
- **WebP**: Supports quality and alpha; limits are handled by sharp.

> Note: sharp's API requires a complete raw Buffer to be passed in when encoding JPEG/WebP, so these two formats load raw data into memory during the final encoding stage (memory/disk checks are performed before this). PNG uses a fully streaming path. This is the best alternative for a library that cannot meet streaming requirements.

### Very Large Image Support

- The tool uses `--max-output-pixels` and memory/disk checks to gate processing, relaxing sharp's built-in input pixel limit (default about 268 million pixels) to unlimited, so it can handle arbitrarily large integer-multiple upscaling.
- Only the `manual` engine needs to decode the entire input image into memory; the `sharp-nearest` engine directly processes the original file with sharp streaming, with memory usage of only ~a few GB (e.g., measured peak `~4 GB` for a 32000→64000 RGBA large image, decoupled from output size).
- Measured pipeline: `32000×32000 → 64000×64000 → 128000×128000 → 256000×256000` (65.536 billion pixels, 262 GB decompressed) all work; each intermediate product is only tens to hundreds of MB after compression.
- At extremely large scales, `-w 1` is recommended (single-threaded reuse of the decode buffer avoids doubled memory usage).

---

## Differences Between manual and sharp-nearest

| | manual (default) | sharp-nearest |
| --- | --- | ---
| Core logic | Hand-written pixel replication | `sharp.resize({ kernel: 'nearest' })` |
| Byte-exact precision | Completely exact (pure replication) | Byte-identical to manual for opaque images |
| Semi-transparent alpha | Exact replication | sharp performs **alpha premultiplication** during resize; semi-transparent pixels may produce byte-level differences |
| Metadata | Pure pixel path, does not preserve EXIF/ICC | Preserved via `withMetadata()` when `--keep-metadata` is used |
| Use case | Main implementation | Fast path / performance comparison baseline |

`--compare` times both separately and performs byte-by-byte pixel verification: results match for opaque images (`✔ consistent`); semi-transparent images may report inconsistency. `--engine auto` selects `sharp-nearest` for small images and indicates the actual engine used in the output.

---

## Performance Notes

Test environment: Windows 11, Node v22, 12 cores. Performance varies with machine and I/O; the following are several representative measured values.

- `1200x900 → 3600x2700` (scale=3): manual about **32–46 MP/s**; sharp-nearest about **100–116 MP/s**; pixel results match.
- `3000x2000 → 9000x6000` (scale=3): manual with 12 threads about **110 MP/s**; single-threaded about **143 MP/s**.

**Regarding the realistic benefits of multi-core (important)**: nearest-neighbor pixel replication is essentially "memory copying"; the bottleneck is **memory bandwidth**, not CPU computation. Therefore, worker parallelism provides limited speedup, and small tasks may even be slightly slower than single-threaded due to thread startup/coordination overhead. The value of multi-core parallelism is mainly reflected in: satisfying the architectural requirement that "number of workers = number of logical cores," larger images (closer to the memory bandwidth limit), and smoother scheduling. This tool uses the manual multi-core path by default, and honestly explains this characteristic.

---

## Code Structure

```
CF-pixel-upscaler/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── cli.ts              # CLI entry point and argument parsing
│   ├── index.ts            # Public API
│   ├── upscaler.ts         # Coordinator: decode → check → schedule → encode
│   ├── worker.ts           # Worker thread
│   ├── progress.ts         # cli-progress real-time progress bar
│   ├── engines/
│   │   ├── manual.ts       # Hand-written pixel replication engine
│   │   └── sharpNearest.ts # sharp nearest-neighbor engine
│   └── utils/
│       ├── check.ts        # Size/memory/disk validation
│       ├── image.ts        # Decoding, format inference, encoding dispatch
│       ├── png.ts          # Custom streaming PNG encoder
│       └── temp.ts         # Temporary file management
└── tests/
    ├── manual.test.ts
    ├── sharpNearest.test.ts
    ├── compare.test.ts
    └── cli.test.ts
```

## Programming Interface

In addition to the CLI, it can also be used as a library:

```ts
import { upscale } from 'cf-pixel-upscaler';

const result = await upscale({
  input: 'in.png',
  output: 'out.png',
  scale: 3,
  compare: true,
});
```

`src/index.ts` also exports core functions such as `replicateRows` / `replicateFull` / `sharpNearestToRaw` for testing and reuse.

## Limitations

- Only **integer-multiple** upscaling (nearest-neighbor pixel replication) is supported; arbitrary scaling/interpolation is not supported.
- JPEG has no alpha; output composites transparency onto a white background.
- `--keep-metadata` currently only takes effect for the `sharp-nearest` engine.
- JPEG/WebP require the complete raw data to be loaded into memory during the final encoding stage (sharp API limitation); PNG is fully streaming.
- The manual engine's full-image streaming PNG path is only enabled for **PNG + `--force` and single-threaded mode**; multi-threaded manual still writes temporary raw in chunks (but chunks are in flight and do not occupy the full output memory at once).
- Multi-core parallelism provides limited speedup for memory-bandwidth-intensive tasks (see "Performance Notes").
