#!/usr/bin/env node
/**
 * test/tpi-host.smoke.mjs — 用假宿主跑通「插件 → job.json → shell.run → worker → result.json」。
 *
 * 它验证的是插件自己的胶水层（路径拼接、作业文件、结果读取、错误传播），不是天枢本体：
 * 真的天枢宿主会用隔离沙箱 + 自己的 bash 工具。这里按同样的契约在进程内模拟一遍，
 * 改完 index.js 不必装进天枢就能看出链路有没有断。
 *
 * 用法：
 *   FFMPEG_PATH=/path/to/ffmpeg node test/tpi-host.smoke.mjs video_probe '{"input":"D:/clip.mp4"}'
 *   FFMPEG_PATH=... node test/tpi-host.smoke.mjs video_storyboard '{"input":"D:/clip.mp4","transcript":"off"}'
 *
 * 依赖：一个真实的视频文件 + ffmpeg（没有 ffprobe 时插件退回 `ffmpeg -i`，见 src/storyboard/probe.js）。
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASH = process.env.TPI_SMOKE_BASH ?? (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe'
  : '/bin/bash');

const host = {
  tpiVersion: '2.0',
  pluginId: 'video-storyboard',
  sessionId: 'smoke',
  isWorker: false,
  log: { debug() {}, warn: (m) => console.error('[warn]', m) },
  workspace: {
    async write(rel, content) {
      const p = join(root, rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
      return null;
    },
    async read(rel) { return readFile(join(root, rel), 'utf8'); },
  },
  shell: {
    async run(command, opts = {}) {
      return await new Promise((done) => {
        // 真实宿主的 bash 工具在 Windows 上走 Git Bash：命令里的引号按 POSIX 规则解析。
        execFile(BASH, ['-c', command], {
          cwd: root, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024,
        }, (err, stdout, stderr) => done({ exitCode: err?.code ?? 0, output: String(stdout) + String(stderr) }));
      });
    },
  },
};

globalThis.__tianshuTPI = { version: '2.0', defineTianshuPlugin: (spec) => spec };
const { default: plugin } = await import(pathToFileURL(join(root, 'index.js')).href);
const contribution = plugin.activate(host);
console.log('plugin id:', plugin.id);
console.log('tools:', contribution.tools.map((t) => `${t.name}(${t.timeoutMs}ms)`).join(', '));

const [tool, argsJson] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node test/tpi-host.smoke.mjs <tool> '<json args>'");
  process.exit(2);
}
const target = contribution.tools.find((t) => t.name === tool);
if (!target) {
  console.error(`no such tool: ${tool}`);
  process.exit(2);
}
const out = await target.execute({ args: JSON.parse(argsJson ?? '{}'), cwd: root });
console.log('--- isError:', out.isError === true);
console.log(out.content);
