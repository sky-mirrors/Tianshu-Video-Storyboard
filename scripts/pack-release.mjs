#!/usr/bin/env node
/**
 * scripts/pack-release.mjs — 按官方《打包、发布与更新》的手动打包流程生成 TPI 2.0 发行 ZIP。
 *
 * 为什么不用开发者套件：本机套件是 tianshu-developer-kit 1.0.0，`src/artifacts.ts:57/91`
 * 把 `$tpi` 与 `compatibility.tpi` 写死成 `literal('1.0')`，会拒掉 2.0 清单。
 * 这里只实现套件里与本插件相关的两条规则：包内容白名单（排除依赖/测试/一次性文件）、
 * 发行记录与内容摘要表；其余由平台验包 API 决定。
 *
 * 用法：
 *   node scripts/pack-release.mjs --release-id rel_video_storyboard_076 \
 *     --publisher-id <id> --source-commit <40位小写> --platforms win32-x64,darwin-arm64,linux-x64
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 只纳入运行所需的代码、许可和资源（publishing.md「包内容」）。 */
const EXCLUDE_TOP = new Set(['test', 'scripts', 'bin', '.rivet', '.tianshu-video-storyboard', '.git', 'dist', 'node_modules']);
const EXCLUDE_FILES = new Set(['.rivet.md', 'package-lock.json', 'xiaosi.release.json', 'xiaosi.contents.json']);

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : null;
};

/** RFC 8785 JCS 的最小实现：键按 UTF-16 码元序排列后无空格序列化（本包全是 ASCII 键）。 */
const jcs = (value) => {
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * ZIP32 存储模式（method 0，不压缩）：同一内容永远得到同一份字节，便于对账；
 * 中央目录与结束记录按 PKWARE 规范手写，时间戳固定 2000-01-01，不随机器时区变。
 * 平台要求包内路径用 `/` 分隔 —— 只能自己写（Windows 上的 zip 工具会写 `\`）。
 */
function buildZip(entries) {
  const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const nameBytes = Buffer.from(path, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc32(data) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc32(data) >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

const releaseId = arg('release-id');
const publisherId = arg('publisher-id');
const sourceCommit = arg('source-commit');
const platforms = (arg('platforms') ?? 'win32-x64').split(',');
if (!releaseId || !publisherId || !sourceCommit) {
  console.error('usage: pack-release.mjs --release-id <id> --publisher-id <id> --source-commit <hash> [--platforms csv]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(root, 'tianshu.plugin.json'), 'utf8'));
const staging = join(root, 'dist', 'staging');
const outZip = join(root, 'dist', `video-storyboard-${manifest.version}.zip`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// 1) 收集源文件（相对路径用 / 分隔）
const collect = (prefix) => {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && EXCLUDE_TOP.has(entry.name)) continue;
    if (EXCLUDE_FILES.has(entry.name)) continue;
    if (entry.isDirectory()) { collect(path); continue; }
    if (!entry.isFile() || statSync(join(root, path)).nlink !== 1) {
      throw new Error(`只接受普通文件（无符号/硬链接）：${path}`);
    }
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(join(staging, path), readFileSync(join(root, path)));
  }
};
collect('');

// 2) package.json 去掉安装类字段（scripts/bin/依赖），其余原样保留 —— type:module 必须留着，
//    否则宿主把 index.js 当 CJS 解析。
const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
for (const key of Object.keys(pkg)) {
  if (['dependencies', 'devDependencies', 'scripts', 'bin', 'main', 'private'].includes(key)) delete pkg[key];
}
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

// 3) 发行记录（compatibility.tpi 必须与清单的 $tpi 一致）
const release = {
  schema: 'xiaosi.release/1',
  release_id: releaseId,
  publisher_id: publisherId,
  plugin_id: manifest.id,
  version: manifest.version,
  channel: 'stable',
  runtime: 'agent',
  compatibility: { tpi: manifest.$tpi, core: manifest.engines.tianshu, platforms },
  data_schema: 1,
  migration_kind: 'none',
  permission_digest: sha256(Buffer.from(jcs(manifest.permissions ?? {}), 'utf8')),
  source_commit: sourceCommit,
};
writeFileSync(join(staging, 'xiaosi.release.json'), `${jcs(release)}\n`);

// 4) 内容摘要表：除自身以外的每个文件
const paths = [];
const walk = (prefix) => {
  for (const entry of readdirSync(join(staging, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { walk(path); continue; }
    if (path !== 'xiaosi.contents.json') paths.push(path);
  }
};
walk('');
const files = Object.fromEntries(paths.sort().map((path) => [
  path, sha256(readFileSync(join(staging, path))),
]));
writeFileSync(join(staging, 'xiaosi.contents.json'), `${jcs({ schema: 'xiaosi.contents/1', files })}\n`);

// 5) 打包：自写 ZIP writer（路径用 / 分隔，见 buildZip）
const entries = [...paths, 'xiaosi.contents.json'].sort()
  .map((path) => [path, readFileSync(join(staging, path))]);
rmSync(outZip, { force: true });
writeFileSync(outZip, buildZip(entries));

const bytes = readFileSync(outZip);
console.log(JSON.stringify({
  zip: relative(root, outZip),
  artifact_sha256: sha256(bytes),
  artifact_bytes: bytes.length,
  entries: entries.length,
  release: { release_id: releaseId, publisher_id: publisherId, tpi: manifest.$tpi, core: manifest.engines.tianshu },
}, null, 2));
rmSync(staging, { recursive: true, force: true });
