#!/usr/bin/env node
/**
 * worker/run.mjs — 在宿主侧进程里跑真正的视频工作。
 *
 * 为什么需要独立进程：TPI 2.0 的插件跑在隔离沙箱里（Windows 上是 AppContainer，
 * 只有插件目录可读、数据目录可写）。ffmpeg/ffprobe 要读任意视频文件、要把帧写进
 * 临时目录，这些在沙箱里都做不了。宿主给的 `shell.run` 是在宿主进程里执行的，
 * 不受沙箱文件白名单限制，所以真正的解码、抽帧、拼图全部放在这里。
 *
 * 输入：`--job <job.json 绝对路径>`，内容见下。
 * 输出：`<job.out>/result.json`
 *
 * job = {
 *   tool: 'storyboard' | 'zoom' | 'probe' | 'locate' | 'help',
 *   args: {...工具参数...},
 *   out:  '<工作区内的输出目录绝对路径>',
 *   workspace: '<会话工作区绝对路径>',
 * }
 *
 * result = { ok: true, text, images: [绝对路径...] } | { ok: false, error }
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { boardOptions } from '../src/storyboard/board.js';
import { lookupCell } from '../src/storyboard/cells.js';
import { formatForDetail, formatPlanPreview, formatProbe, formatRemoteProbe, saveStoryboards } from '../src/storyboard/format.js';
import { isHttpUrl } from '../src/storyboard/url.js';
import { probeVideo } from '../src/storyboard/probe.js';
import { probeUrl } from '../src/storyboard/fetch.js';
import { runStoryboard } from '../src/storyboard/pipeline.js';
import { resolveInput } from '../src/storyboard/fetch.js';
import { formatMatches, matchSegments, recallSegments } from '../src/storyboard/locate.js';
import { videoHelp } from '../src/storyboard/help.js';

const jobPath = (() => {
  const at = process.argv.indexOf('--job');
  return at >= 0 ? process.argv[at + 1] : null;
})();

/** 写结果并退出。这是插件与 worker 之间唯一的回执通道。 */
async function finish(outDir, payload) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'result.json'), `${JSON.stringify(payload)}\n`, 'utf8');
}

/** 分镜/放大共用：跑管线，把每张图落到 outDir，返回 { text, images }。 */
async function runBoard(options, { detail, cellRange, outDir }) {
  const result = await runStoryboard(options);
  if (result.planOnly) return { text: formatPlanPreview(result), images: [] };
  const images = await saveStoryboards(result, join(outDir, 'storyboard.png'), { quality: 4 });
  return { text: formatForDetail(result, { detail, cellRange }), images };
}

async function storyboard(args, outDir) {
  return runBoard(boardOptions(args, { kind: 'board' }), {
    detail: args.detail, cellRange: args.cellRange ?? null, outDir,
  });
}

async function zoom(args, outDir) {
  let from = args.from;
  let to = args.to;
  if (args.cellId !== undefined && args.cellId !== null) {
    const hit = await lookupCell(args.input, args.cellId);
    if (!hit) {
      throw new Error(`no cell map recorded for this input (cellId ${args.cellId}). `
        + 'Run video_storyboard on it first, or pass from/to.');
    }
    from = hit.from;
    to = hit.to;
  }
  return runBoard(boardOptions({ ...args, from, to }, { kind: 'zoom' }), {
    detail: args.detail ?? 'med', cellRange: null, outDir,
  });
}

async function probe(args) {
  if (!args?.input) throw new Error('input is required');
  if (isHttpUrl(args.input)) {
    const remote = await probeUrl(args.input, {
      cookies: args.cookies, allowAnonymous: args.allowAnonymous === true,
    });
    return { text: formatRemoteProbe(remote), images: [] };
  }
  const info = { ...(await probeVideo(args.input)), path: args.input };
  return { text: await formatProbe(info), images: [] };
}

async function locate(args) {
  if (!args?.input) throw new Error('input is required');
  if (!args?.query) throw new Error('query is required');
  const max = Math.min(20, Math.max(1, Number(args.max) || 5));
  const resolved = await resolveInput(args.input, {
    cookies: args.cookies, allowAnonymous: args.allowAnonymous === true,
  });
  let segments = recallSegments(resolved.path);
  if (!segments) {
    await runStoryboard({
      input: resolved.path, from: args.from, to: args.to, cells: 1,
      transcriptFile: args.transcriptFile, textOnly: true, encode: false,
    });
    segments = recallSegments(resolved.path);
  }
  if (!segments || segments.length === 0) {
    return {
      text: 'no transcript available for this file: run video_storyboard first, '
        + 'or pass transcriptFile. Without a transcript there is nothing to match on.',
      images: [],
    };
  }
  const lo = Number.isFinite(args.from) ? args.from : 0;
  const hi = Number.isFinite(args.to) ? args.to : Infinity;
  const inWindow = segments.filter((x) => x.to >= lo && x.from <= hi);
  const matches = matchSegments(inWindow, args.query, { max });
  return { text: formatMatches(args.query, matches, { total: inWindow.length }), images: [] };
}

async function main() {
  if (!jobPath) throw new Error('usage: node worker/run.mjs --job <job.json>');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  const outDir = String(job.out);
  const args = job.args ?? {};
  const handlers = { storyboard, zoom, probe, locate };
  try {
    const result = job.tool === 'help'
      ? { text: videoHelp(args.topic), images: [] }
      : await handlers[job.tool](args, outDir);
    await finish(outDir, { ok: true, text: result.text, images: result.images });
  } catch (error) {
    await finish(outDir, { ok: false, error: String(error?.message ?? error) });
    process.exitCode = 1;
  }
}

await main();
