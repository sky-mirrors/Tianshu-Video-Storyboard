#!/usr/bin/env node
/**
 * scripts/real-host-check.mjs — 用**天枢自己的 runtime**验证插件，而不是 mock。
 *
 * 三段，逐步加深：
 *   1. 清单校验：import 宿主的 readTpiManifest / parseTpiManifest（不是第三方 jsonschema）
 *   2. 真沙箱绑定：import 宿主的 bindIsolatedTpiPlugin
 *      （Windows 上是 AppContainer + Node --permission 白名单，Linux 是 seccomp 启动器）
 *   3. 沙箱内调用：按参数跑一个工具，把回执打出来
 *
 * 用法（先把插件目录放到 ~/.rivet/plugins/video-storyboard，或设 VIDEO_STORYBOARD_DIR）：
 *   node scripts/real-host-check.mjs                       # 只做 1、2 两段
 *   node scripts/real-host-check.mjs video_probe '{"input":"D:/clip.mp4"}'   # 加第 3 段
 *
 * 环境变量：
 *   TIANSHU_RUNTIME 宿主 runtime 目录（默认 D:/Tianshu/rivet-runtime）
 *   VIDEO_STORYBOARD_DIR 插件目录（默认 ~/.rivet/plugins/video-storyboard）
 *   SOCIAL_WORKSPACE 沙箱调用时的工作区（默认当前临时目录）
 *   TPI_SMOKE_BASH  shell.run 用哪个 bash（默认 Windows 走 Git Bash）
 *
 * 注意：`shell.run` 在真宿主里是宿主的 bash 工具；这里用本地 bash 代跑，契约相同
 * （命令字符串 + cwd + timeoutMs + signal），但它不是宿主那份实现。
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RT = process.env.TIANSHU_RUNTIME ?? 'D:/Tianshu/rivet-runtime';
const workspace = process.env.SOCIAL_WORKSPACE ?? join(tmpdir(), 'tianshu-video-storyboard-check');
const pluginDir = process.env.VIDEO_STORYBOARD_DIR ?? join(homedir(), '.rivet', 'plugins', 'video-storyboard');
const dataDir = join(workspace, '.tpi-data');
const BASH = process.env.TPI_SMOKE_BASH
  ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');

const { readTpiManifest } = await import(pathToFileURL(join(RT, 'chunk-JHS3EY74.js')).href);
const tpi = await import(pathToFileURL(join(RT, 'chunk-CIXVI7BW.js')).href);
const { bindIsolatedTpiPlugin } = await import(pathToFileURL(join(RT, 'chunk-RARWTZDC.js')).href);

// ── 1. 清单校验（宿主自己的解析器）
console.log(`runtime TPI_VERSION=${tpi.TPI_VERSION} supported=${JSON.stringify(tpi.TPI_SUPPORTED_VERSIONS)}`);
const read = readTpiManifest(pluginDir);
console.log(`readTpiManifest ok=${read.ok}${read.ok ? '' : ` status=${read.status} error=${read.error}`}`);
if (!read.ok) process.exit(1);
const manifest = read.manifest;
const parsed = tpi.parseTpiManifest(JSON.parse(readFileSync(join(pluginDir, 'tianshu.plugin.json'), 'utf8')));
console.log(`parseTpiManifest ok=${parsed.ok}${parsed.ok ? '' : ` errors=${JSON.stringify(parsed.errors)}`}`);
console.log(`  id=$tpi ${manifest.id} / ${manifest.$tpi} · tools=${manifest.contributes.tools.length}`);

// ── 2. 真沙箱绑定
mkdirSync(workspace, { recursive: true });
mkdirSync(dataDir, { recursive: true });
const runShell = (command, opts = {}) => new Promise((done) => {
  execFile(BASH, ['-c', command], {
    cwd: opts.cwd ?? workspace,
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  }, (err, stdout, stderr) => done({ exitCode: err?.code ?? 0, output: String(stdout) + String(stderr) }));
});

const bound = await bindIsolatedTpiPlugin(
  { manifest, granted: [...manifest.capabilities], packageDir: pluginDir, dataDir },
  {
    node: process.execPath,
    // services.cwd 是会话工作区根：createIsolatedServices 用它来解析 workspace.* 的相对路径。
    services: { userKey: 'real-host-check', runShell, cwd: workspace },
    deps: {},
    // 宿主把会话工作区根从这里取；缺了它 workspace.write 会拿 undefined 去 resolve。
    cwd: workspace,
    workspace,
    signal: new AbortController().signal,
  },
);
console.log(`沙箱绑定成功: ${bound.pluginId} · tools=${bound.tools.length} · 能力=${bound.tools[0]?.constructor?.name ?? 'n/a'}`);

// ── 3. 沙箱内调用（可选）
const [tool, argsJson] = process.argv.slice(2);
if (tool) {
  const target = bound.tools.find((t) => t.definition?.name === tool);
  if (!target) throw new Error(`no such tool: ${tool}`);
  const started = Date.now();
  const out = await target.execute({ input: JSON.parse(argsJson ?? '{}'), cwd: workspace });
  console.log(`\n=== ${tool} (${Date.now() - started}ms) isError=${out?.isError === true}`);
  console.log(out?.content?.slice(0, 1200));
}

bound.stop?.();
await bound.dispose?.();
process.exit(0);
