#!/usr/bin/env node
/**
 * scripts/contract-check.mjs — 逐条核对本插件是否满足 **天枢 TPI 2.0 契约**。
 *
 * 条款不是抄文档，是从宿主 runtime 的实现里读出来的：
 *   - `chunk-CIXVI7BW.js`：`parseTpiManifest` 的 zod schema + superRefine（能力↔权限配对）
 *   - `chunk-RARWTZDC.js`：sandbox 的 `toolDeclaration`（name≤64 / description≤2000 / timeoutMs≤600000）
 *   - `chunk-RARWTZDC.js` 的 `assertPrivateTree`：插件目录不得有符号链接（nlink 必须为 1）
 *   - `chunk-JHS3EY74.js` 的 `readTpiManifest`：文件读取 + legacy 格式拒绝
 *
 * 用法：node scripts/contract-check.mjs [插件目录]
 * 退出码 0 = 全部 PASS；1 = 有 FAIL。
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const RT = process.env.TIANSHU_RUNTIME ?? 'D:/Tianshu/rivet-runtime';
const dir = process.argv[2] ?? join(homedir(), '.rivet', 'plugins', 'video-storyboard');

const { parseTpiManifest, TPI_SUPPORTED_VERSIONS } = await import(pathToFileURL(join(RT, 'chunk-CIXVI7BW.js')).href);
const { readTpiManifest } = await import(pathToFileURL(join(RT, 'chunk-JHS3EY74.js')).href);

const rows = [];
const check = (id, clause, ok, detail = '') => rows.push({ id, clause, ok, detail });

// ── 条款：文件与解析（宿主入口）
const read = readTpiManifest(dir);
check('F1', 'tianshu.plugin.json 存在且能被 readTpiManifest 接受', read.ok, read.ok ? '' : `${read.status}: ${read.error}`);
if (!read.ok) { report(); process.exit(1); }

const raw = JSON.parse(readFileSync(join(dir, 'tianshu.plugin.json'), 'utf8'));
const m = raw;
const parsed = parseTpiManifest(raw);
check('F2', 'parseTpiManifest（含 superRefine）通过', parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.errors));

// ── 条款：清单字段
check('M1', `$tpi ∈ ${JSON.stringify(TPI_SUPPORTED_VERSIONS)}`, TPI_SUPPORTED_VERSIONS.includes(m.$tpi), m.$tpi);
check('M2', "kind === 'tianshu.plugin'", m.kind === 'tianshu.plugin', m.kind);
check('M3', 'id 匹配 ^[A-Za-z0-9][A-Za-z0-9._-]*$ 且 1..128', /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.id) && m.id.length <= 128, `${m.id} (${m.id.length})`);
check('M4', 'displayName 1..64', m.displayName.length >= 1 && m.displayName.length <= 64, `${m.displayName.length}`);
check('M5', 'version 为严格的 x.y.z', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.version), m.version);
check('M6', 'description 1..500', m.description.length >= 1 && m.description.length <= 500, `${m.description.length}`);
// 用 zod 已过 default 的输出：runtime 在 schema 里是 literal('agent').default('agent')，
// 缺省即合法，拿原始 JSON 比对会出假 FAIL。
check('M7', "runtime === 'agent'（TPI 2.0 只允许 agent）", parsed.manifest.runtime === 'agent', parsed.manifest.runtime);
check('M8', 'entry 非空且文件存在', Boolean(m.entry) && lstatSync(join(dir, m.entry)).isFile(), m.entry);
check('M9', 'engines.tianshu 必填（TPI 2.0 的 required）', typeof m.engines?.tianshu === 'string' && m.engines.tianshu.length > 0, m.engines?.tianshu);

// ── 条款：工具声明（manifest 侧限 200 字符，运行时侧限 2000）
for (const t of m.contributes?.tools ?? []) {
  check(`T:${t.name}`, 'name 匹配 ^[a-z][a-z0-9_]*$ 且 ≤64', /^[a-z][a-z0-9_]*$/.test(t.name) && t.name.length <= 64, `${t.name.length}`);
  check(`T:${t.name}:d`, 'manifest description 1..200', t.description.length >= 1 && t.description.length <= 200, `${t.description.length}`);
}
check('T10', '工具名不重复', new Set((m.contributes?.tools ?? []).map((t) => t.name)).size === (m.contributes?.tools ?? []).length);
check('T11', "hookScripts 为空（TPI 2.0 禁止脚本钩子，maxItems 0）", !m.contributes?.hookScripts || m.contributes.hookScripts.length === 0);
check('T12', 'contributes.tools 非空时必须声明 "tools" 能力', (m.contributes?.tools?.length ?? 0) === 0 || (m.capabilities ?? []).includes('tools'));

// ── 条款：运行时侧（sandbox 的 toolDeclaration）
const spec = await import(pathToFileURL(join(dir, 'src/storyboard/tool-spec.js')).href);
const specs = [spec.storyboardToolSpec(), spec.zoomToolSpec(), spec.probeToolSpec(), spec.locateToolSpec(), spec.subtitlesToolSpec(), spec.helpToolSpec()];
// 存在性先于遍历：specs 静默变空时，下面的 for 会零条通过（和 timeout 那次一样的坑）。
check('R:spec-count', '运行时 spec 数与 manifest 工具声明数一致', specs.length === (m.contributes?.tools?.length ?? 0), `${specs.length} vs ${m.contributes?.tools?.length ?? 0}`);
for (const s of specs) {
  check(`R:${s.name}`, '运行时 description ≤2000（text(0x7d0)）', s.description.length <= 2000, `${s.description.length}`);
}
// timeoutMs 只能从源码读：index.js 顶层会调用 defineTianshuPlugin，宿主外 import 会抛。
// 注意 `timeoutMs: TIMEOUT_MS[name]` 不是数字字面量——要解析 TIMEOUT_MS 表本身。
const indexSrc = readFileSync(join(dir, 'index.js'), 'utf8');
const table = indexSrc.match(/const TIMEOUT_MS = \{([\s\S]*?)\};/)?.[1] ?? '';
const entries = [...table.matchAll(/(\w+):\s*([0-9_]+)/g)].map(([, name, lit]) => [name, Number(lit.replace(/_/g, ''))]);
check('R:timeout-count', 'TIMEOUT_MS 表里每个对外工具都有超时', entries.length === (m.contributes?.tools?.length ?? 0), `${entries.length} vs ${m.contributes?.tools?.length ?? 0}`);
for (const [name, n] of entries) {
  check(`R:timeout:${name}`, 'timeoutMs ≤ 600000（10*60000）且为正', n > 0 && n <= 600_000, `${n}`);
}

// ── 条款：目录卫生（assertPrivateTree：nlink 必须为 1，不能有符号链接）
const violations = [];
const walk = (p, depth = 0) => {
  if (depth > 32) return;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, e.name);
    const st = lstatSync(full);
    if (st.isDirectory()) { walk(full, depth + 1); continue; }
    if (!st.isFile() || st.nlink !== 1) violations.push(relative(dir, full));
  }
};
walk(dir);
check('D1', '插件目录内无符号链接 / 硬链接（nlink 必须为 1）', violations.length === 0, violations.slice(0, 3).join(', '));

report();

function report() {
  const bad = rows.filter((r) => !r.ok);
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(8)} ${r.clause}${r.detail ? `   [${r.detail}]` : ''}`);
  console.log(`\n${rows.length - bad.length}/${rows.length} PASS`);
  if (bad.length) {
    console.log('\n未通过的条款：');
    for (const r of bad) console.log(` - ${r.id}: ${r.clause} ${r.detail}`);
    process.exitCode = 1;
  }
}
