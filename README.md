# CF-pixel-upscaler

一个 Node.js 整数倍**像素复制放大**（最近邻 / nearest-neighbor）命令行工具。

放大方式本质是「单个像素成倍复制」：`100x200` 的图以 `scale=2` 放大后得到 `200x400`，每个原始像素在输出中变成一个 `2x2` 的相同像素块。

- 默认使用**手写 `manual` 像素复制引擎**（主实现，显式复制像素，不依赖 `sharp.resize` 完成核心放大）。
- `sharp-nearest` 作为可选快速路径与性能对比基准（`sharp.resize({ kernel: 'nearest' })`）。
- 多核并行（`worker_threads`）、SharedArrayBuffer 零拷贝、流式写出临时 raw、实时进度条。
- 正确性优先，其次是多核性能、内存安全与进度反馈。

---

## 技术栈

| 依赖 | 用途 |
| --- | --- |
| `sharp` | 图像元数据读取、解码为 raw RGBA、最终编码（JPEG/WebP） |
| `worker_threads` | 多核并行（本工具用原始 `worker_threads` 而非 `piscina`，以便精确控制 SharedArrayBuffer 零拷贝、transferable 与乱序块顺序组装，见「原理」） |
| `commander` | CLI 参数解析 |
| `cli-progress` | 实时进度条 |
| `vitest` | 测试 |

> 未使用 Jimp（性能不足）。

Node.js 版本要求：`>= 20`。

---

## 安装与构建

```bash
npm install
npm run build       # 编译 TypeScript 到 dist/
```

构建产物：`dist/cli.js`（可执行入口，`bin` 指向 `pixel-upscaler`）。

## 测试

```bash
npm test            # vitest run
```

---

## 使用示例

```bash
# 最基本用法：scale=2（默认 manual 引擎）
node dist/cli.js -i input.png -o output.png -s 2

# 指定倍数
node dist/cli.js -i input.png -o out.png -s 4

# 指定 worker 数量
node dist/cli.js -i input.png -o out.png -s 4 -w 8

# 输出 JPEG / WebP（按扩展名自动识别，也可 --format 指定）
node dist/cli.js -i input.png -o out.jpg -s 2 --quality 85
node dist/cli.js -i input.png -o out.webp -s 2 --quality 85

# 使用 sharp 快速路径
node dist/cli.js -i input.png -o out.png -s 3 --engine sharp-nearest

# 性能对比模式：分别运行 manual 与 sharp-nearest，输出耗时/吞吐/内存峰值并校验像素一致
node dist/cli.js -i input.png -o out.png -s 3 --compare

# 覆盖已存在输出、允许超过安全阈值
node dist/cli.js -i input.png -o out.png -s 3 --overwrite --force

# 超大图（如 32000x32000 或更大）：流式处理，不整图载入内存、不产生 GB 级临时文件
#   - PNG 走流式编码，磁盘上只有压缩后的小文件（解压时才是巨量像素）
#   - sharp-nearest 引擎由 libvips 流式读写，内存占用与输出尺寸解耦
node dist/cli.js -i big.png -o big_x2.png -s 2 -w 1 --max-output-pixels 20000000000 --force
```

### 全部参数

| 参数 | 简写 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--input` | `-i` | 必填 | 输入图片路径 |
| `--output` | `-o` | 必填 | 输出图片路径 |
| `--scale` | `-s` | `2` | 放大倍数（正整数） |
| `--workers` | `-w` | CPU 逻辑核心数 | worker 数量 |
| `--chunk-rows` | | 自动 | 每个任务处理的输入行数（0=自动） |
| `--format` | | 按扩展名 | `png` \| `jpeg` \| `webp` |
| `--quality` | | `90` | JPEG/WebP 质量（1-100） |
| `--max-output-pixels` | | `1e9` | 输出像素安全阈值，超过则拒绝 |
| `--force` | | 关 | 允许超过安全阈值 / 内存磁盘限制（会警告） |
| `--temp-dir` | | 系统临时目录 | 临时目录 |
| `--overwrite` | | 关 | 允许覆盖已存在的输出文件 |
| `--keep-metadata` | | 关 | 尽量保留 EXIF/ICC（仅 sharp-nearest 引擎） |
| `--engine` | | `manual` | `manual` \| `sharp-nearest` \| `auto` |
| `--compare` | | 关 | manual 与 sharp-nearest 性能对比 |
| `--no-progress` | | 关 | 禁用进度条 |

---

## 输出尺寸与安全检查

- `outWidth = inWidth * scale`，`outHeight = inHeight * scale`，全部用 `BigInt` 计算并对齐 `Number.MAX_SAFE_INTEGER`。
- 检查各格式单边上限：PNG `2^31-1`、JPEG `65535`、WebP `16383`。
- 检查磁盘剩余空间（`fs.statfs`，不可用则跳过）与可用内存。
- 超过 `--max-output-pixels` 且未加 `--force` 时，报错退出并给出中文提示与退出码。

---

## 核心算法（manual 手写引擎）

`src/engines/manual.ts` 显式实现了像素复制：

```ts
// 对每个输入行，先做水平放大：每个像素重复 scale 次，构造一条输出行
for (let x = 0; x < srcWidth; x++) {
  const r = src[sp], g = src[sp+1], b = src[sp+2], a = src[sp+3];
  for (let k = 0; k < scale; k++)
    expandedRow[(x*scale + k)*4] = r/a/g/b ...; // 每个像素重复 scale 次
}
// 再做垂直放大：把这条输出行重复 scale 次
for (let k = 0; k < scale; k++)
  out.set(expandedRow, base + k * outRowBytes); // 行重复 scale 次
```

这与 `out[outY][outX] = src[floor(outY/scale)][floor(outX/scale)]` 完全等价，是**逐字节精确复制**，不做任何插值、滤波或色彩管理（默认直接复制 raw 像素，保持 sRGB 值不变）。

---

## 多核并行与内存安全

- 输入 raw 像素放入 `SharedArrayBuffer`，所有 worker 零拷贝共享，不重复拷贝输入。
- 按输入行分块：任务 `i` 处理 `[startSrcY, endSrcY)`，生成输出行 `[startSrcY*scale, endSrcY*scale)`。
- worker 返回**带序号**的输出缓冲（通过 `transferable` 转移所有权，零拷贝），主线程按序号顺序写入临时 raw 文件；乱序完成的块先缓存，**在途任务数 = worker 数**，避免内存爆炸。
- 主线程只做调度、顺序写盘与进度条，不做重计算。
- **小图自动降级单线程**（输出像素 < 100 万且未显式 `--workers`），避免 worker 启动开销。
- 全程**不一次性生成完整放大图**：放大后的 raw 分块流式写入临时文件，最后由 sharp（JPEG/WebP）或自研流式 PNG 编码器编码为目标格式。SIGINT 或退出时清理临时文件。

---

## 图像格式与流式编码

- **PNG**：推荐、无损、支持 alpha。使用自研流式 PNG 编码器（`src/utils/png.ts`：zlib deflate + 手写 PNG chunk），按行流式编码，**内存占用与输出尺寸无关**。在 PNG + `--force` 场景下 manual 引擎会把放大结果**直接喂入 PNG 压缩流**，跳过临时 raw 文件，从而在超大图上也不产生 GB 级临时文件、磁盘上只有压缩后的小文件。
- **JPEG**：不支持 alpha，会把 alpha 合成到白底再编码；宽高上限 65535。
- **WebP**：支持质量与 alpha，限制由 sharp 处理。

> 说明：sharp 的 API 要求 JPEG/WebP 编码时传入完整 raw Buffer，因此这两种格式在最终编码阶段会把 raw 载入内存（已在此之前做内存/磁盘检查）。PNG 则走完全流式路径。这是对「无法满足流式要求的库」选择的最佳替代方案。

### 超大图支持

- 工具自行通过 `--max-output-pixels` 与内存/磁盘检查把关，把 sharp 的内建输入像素限制（默认约 2.68 亿像素）放宽为**不限制**，因此能处理任意超大整数倍放大。
- 仅 `manual` 引擎才需要把输入整图解码进内存；`sharp-nearest` 引擎直接用 sharp 流式处理原文件，内存占用仅 ~几 GB（如 32000→64000 的 RGBA 大图实测峰值 `~4 GB`，与输出尺寸解耦）。
- 实测链路：`32000×32000 → 64000×64000 → 128000×128000 → 256000×256000`（655.36 亿像素、解压 262 GB）均可用，每个中间产物压缩后仅数十至数百 MB。
- 超大量级时建议 `-w 1`（单线程复用解码 buffer，避免翻倍占用内存）。

---

## manual 与 sharp-nearest 的差异

| | manual（默认） | sharp-nearest |
| --- | --- | ---
| 核心逻辑 | 手写像素复制 | `sharp.resize({ kernel: 'nearest' })` |
| 逐字节精度 | 完全精确（纯复制） | 不透明图像下与 manual 逐字节一致 |
| 半透明 alpha | 精确复制 | sharp 在 resize 时做 **alpha 预乘**，半透明像素可能产生字节级差异 |
| 元数据 | 纯像素路径，不保留 EXIF/ICC | `--keep-metadata` 时通过 `withMetadata()` 保留 |
| 用途 | 主实现 | 快速路径 / 性能对比基准 |

`--compare` 会对两者分别计时并做逐字节像素校验：不透明图像结果一致（`✔ 一致`）；半透明图像可能报告不一致。`--engine auto` 会在小图时选择 `sharp-nearest`，并在输出中提示实际使用的引擎。

---

## 性能说明

测试环境：Windows 11，Node v22，12 核。性能会因机器与 I/O 波动，以下为若干代表性实测值。

- `1200x900 → 3600x2700`（scale=3）：manual 约 **32–46 MP/s**；sharp-nearest 约 **100–116 MP/s**，两者像素结果一致。
- `3000x2000 → 9000x6000`（scale=3）：manual 12 线程约 **110 MP/s**；单线程约 **143 MP/s**。

**关于多核的现实收益（重要）**：最近邻像素复制本质是「内存复制」，瓶颈在**内存带宽**而非 CPU 计算。因此 worker 并行带来的加速有限，小任务甚至可能因线程启动/协调开销而略慢于单线程。多核并行的价值主要体现在：符合「worker 数 = 逻辑核心数」的架构要求、更大图（更逼近内存带宽上限）以及更平滑的调度。本工具默认使用 manual 多核路径，close 如实说明这一特性。

---

## 代码结构

```
pixel-upscaler/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── cli.ts              # CLI 入口与参数解析
│   ├── index.ts            # 对外 API
│   ├── upscaler.ts         # 协调器：解码→检查→调度→编码
│   ├── worker.ts           # 工作线程
│   ├── progress.ts         # cli-progress 实时进度条
│   ├── engines/
│   │   ├── manual.ts       # 手写像素复制引擎
│   │   └── sharpNearest.ts # sharp 最近邻引擎
│   └── utils/
│       ├── check.ts        # 尺寸/内存/磁盘校验
│       ├── image.ts        # 解码、格式推断、编码分发
│       ├── png.ts          # 自研流式 PNG 编码器
│       └── temp.ts         # 临时文件管理
└── tests/
    ├── manual.test.ts
    ├── sharpNearest.test.ts
    ├── compare.test.ts
    └── cli.test.ts
```

## 编程接口

除 CLI 外，也可作为库使用：

```ts
import { upscale } from 'cf-pixel-upscaler';

const result = await upscale({
  input: 'in.png',
  output: 'out.png',
  scale: 3,
  compare: true,
});
```

`src/index.ts` 同时导出 `replicateRows` / `replicateFull` / `sharpNearestToRaw` 等核心函数以便测试与复用。

## 限制说明

- 仅支持**整数倍**放大（最近邻像素复制），不支持任意比例缩放/插值。
- JPEG 无 alpha，输出会把透明度合成到白底。
- `--keep-metadata` 目前仅对 `sharp-nearest` 引擎生效。
- JPEG/WebP 最终编码阶段需完整 raw 载入内存（sharp API 限制）；PNG 为完全流式。
- manual 引擎的整图流式 PNG 路径仅在 **PNG + `--force` 且单线程**时启用；多线程 manual 仍分块写临时 raw（但分块在途，不一次性占用完整输出内存）。
- 多核并行对内存带宽密集型任务加速有限（见「性能说明」）。