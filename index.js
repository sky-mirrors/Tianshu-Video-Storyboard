/**
 * index.js — 天枢 TPI 2.0 入口。只做三件事：注册工具、写作业文件、把 shell.run 的结果读回来。
 *
 * 分工（为什么这么切）：
 *   - 插件进程跑在隔离沙箱里（Windows 上是 AppContainer）：只读得到插件目录，只写得了
 *     插件数据目录。ffmpeg 要读任意视频、要写临时帧，沙箱里做不到。
 *   - 宿主给的 `shell.run` 在**宿主进程**里执行，没有沙箱文件白名单的限制 —— 所以真正的
 *     解码、抽帧、拼图全部交给 `worker/run.mjs`，它跑在上游原封不动的算法层上。
 *   - 两边只通过工作区里的一个 JSON 文件交换结果：插件先写 job.json，worker 写
 *     result.json，插件用 workspace.read 读回来。图片由 worker 直接落到工作区。
 *
 * 因此工具返回**文本 + 图片绝对路径**：TPI 2.0 的工具回执只有 content 字符串，
 * 没有 DSH 的 attachments 通道，模型用看文件的方式打开这些图。
 *
 * 面板（views/library.html）读的是同一个进程里的 `library` 数组，经 `ui.onMessage` 应答：
 * 视图与插件同在一个 sandbox child 里，不需要落盘共享状态。
 */

import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTianshuPlugin } from './tpi.js';
import { parametersToJsonSchema } from './lib/schema.js';
import {
  helpToolSpec, locateToolSpec, probeToolSpec, storyboardToolSpec, subtitlesToolSpec, validateToolArgs,
  validateZoomArgs, zoomToolSpec,
} from './src/storyboard/tool-spec.js';

const SPECS = [storyboardToolSpec, zoomToolSpec, probeToolSpec, locateToolSpec, subtitlesToolSpec, helpToolSpec];
/**
 * 上游 spec 名 → 天枢里的对外工具名。
 *
 * `video_probe` 与已装的 media-toolkit 插件（TPI 1.0）重名，宿主遇到跨版本重名的行为
 * 我没能取证（代码与日志都没有明文）。与其赌它"后者覆盖"，不如在插件边界把名字改掉——
 * 上游的 `tool-spec.js` 与它的 49 个测试因此保持原样，改名只发生在这一层。
 */
const RENAME = { video_probe: 'video_storyboard_probe' };
/** 对外工具名 → worker 里的工具标识（worker/run.mjs 的 handlers 键）。 */
const WORKER_TOOL = {
  video_storyboard: 'storyboard',
  video_zoom: 'zoom',
  video_storyboard_probe: 'probe',
  video_locate: 'locate',
  video_subtitles: 'subtitles',
  video_help: 'help',
};
/** 每种工具的超时（宿主 shell.run 上限 600000ms）。 */
const TIMEOUT_MS = {
  video_storyboard: 300_000,
  video_zoom: 300_000,
  video_storyboard_probe: 60_000,
  video_locate: 300_000,
  video_subtitles: 180_000,
  video_help: 10_000,
};
/** 真正吃时间的工具：调它们时给状态栏一个进度提示。 */
const SLOW_TOOLS = new Set(['video_storyboard', 'video_zoom', 'video_subtitles']);
/** 一次回执里最多列几张图的路径；其余只报数量（两小时的片子能出十几张）。 */
const IMAGE_PAGE = 4;
/** 面板保留最近多少次运行。 */
const LIBRARY_MAX = 20;

const WORKER = fileURLToPath(new URL('./worker/run.mjs', import.meta.url));

/** 把结果 JSON 折成工具回执文本：索引在前，图片路径按页给（模型按需打开）。 */
function renderResult(result) {
  const parts = [result.text];
  const images = result.images ?? [];
  if (images.length > 0) {
    const shown = images.slice(0, IMAGE_PAGE);
    parts.push('', `分镜图（用 read_file 打开查看；共 ${images.length} 张，先列 ${shown.length} 张）：`);
    for (const p of shown) parts.push(`- ${p}`);
    if (images.length > shown.length) {
      parts.push('', `其余 ${images.length - shown.length} 张与上面同一目录、文件名按序号递增；需要时再取。`);
    }
  }
  return parts.join('\n');
}

/** 从结果文本里抠出格子数，喂给面板卡片；抠不到就不写，不猜。 */
function summarize(text) {
  const cells = /grid="([0-9]+) frames/.exec(text)?.[1];
  return cells ? { cells: Number(cells) } : {};
}

export default defineTianshuPlugin({
  id: 'video-storyboard',
  activate(host) {
    /** 面板的最近运行记录（视图与插件同进程，直接共享）。 */
    const library = [];

    const tools = SPECS.map((spec) => {
      const { name: specName, description, parameters } = spec();
      const name = RENAME[specName] ?? specName;
      return {
        name,
        description,
        inputSchema: parametersToJsonSchema(parameters),
        timeoutMs: TIMEOUT_MS[name],
        async execute({ args, cwd }) {
          // video_help 不带 input（它只回手册），与上游 tools/help.js 一致，不跑参数校验。
          if (name !== 'video_help') {
            const problems = name === 'video_zoom' ? validateZoomArgs(args) : validateToolArgs(args);
            if (problems.length > 0) return { content: `invalid arguments: ${problems.join('; ')}`, isError: true };
          }
          const tool = WORKER_TOOL[name];
          const runId = `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const rel = `.tianshu-video-storyboard/${runId}`;
          const outDir = `${cwd}/${rel}`.replace(/\\/g, '/');
          // 作业文件写在工作区**根上**：宿主的 workspace.write 不会创建父目录（真机实测
          // ENOENT: ...\.tianshu-video-storyboard\<runId>\job.json）。子目录由 worker 自己建。
          const jobFile = `.tianshu-video-storyboard-job-${runId}.json`;

          const started = Date.now();
          // 进度提示：statusItems 已在 manifest 声明。宿主不支持时静默跳过，绝不影响出结果。
          if (SLOW_TOOLS.has(name)) {
            void host.ui?.setStatus('job', `正在跑 ${name} · ${basename(String(args.input ?? ''))}`).catch(() => {});
          }

          await host.workspace.write(jobFile, JSON.stringify({ tool, args, out: outDir, workspace: cwd }));
          await host.shell.run(`"${process.execPath}" "${WORKER}" --job "${cwd}/${jobFile}"`, {
            timeoutMs: TIMEOUT_MS[name],
          });
          const result = JSON.parse(await host.workspace.read(`${rel}/result.json`));

          if (SLOW_TOOLS.has(name)) {
            void host.ui?.setStatus('job', result.ok ? `完成 ${name}` : `${name} 失败`).catch(() => {});
          }
          if (!result.ok) return { content: `[${name}] ${result.error}`, isError: true };

          library.unshift({
            tool: name,
            label: basename(String(args.input ?? '')) || name,
            at: Date.now(),
            ms: Date.now() - started,
            images: result.images ?? [],
            ...summarize(result.text ?? ''),
          });
          if (library.length > LIBRARY_MAX) library.length = LIBRARY_MAX;
          // 面板若开着，让它立刻刷新；失败不影响工具回执。
          void host.ui?.post('library', { type: 'job', at: Date.now() }).catch(() => {});

          return { content: renderResult(result) };
        },
      };
    });

    return {
      tools,
      ui: {
        /** 视图发来的请求：{type:'list'} | {type:'last'}。返回值就是视图收到的回复。 */
        async onMessage(_view, message) {
          const type = message?.type;
          if (type === 'list') return { jobs: library };
          if (type === 'last') return { jobs: library.slice(0, 1) };
          return null;
        },
        /** 命令面板里不带视图的命令（manifest 的 contributes.ui.commands）。 */
        async onCommand(id) {
          if (id !== 'refresh') return;
          await host.ui?.post('library', { type: 'job', at: Date.now() }).catch(() => {});
        },
      },
    };
  },
});
