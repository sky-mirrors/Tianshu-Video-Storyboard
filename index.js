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
 */

import { fileURLToPath } from 'node:url';

import { defineTianshuPlugin } from './tpi.js';
import { parametersToJsonSchema } from './lib/schema.js';
import {
  helpToolSpec, locateToolSpec, probeToolSpec, storyboardToolSpec, validateToolArgs,
  validateZoomArgs, zoomToolSpec,
} from './src/storyboard/tool-spec.js';

const SPECS = [storyboardToolSpec, zoomToolSpec, probeToolSpec, locateToolSpec, helpToolSpec];
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
  video_help: 'help',
};
/** 每种工具的超时（宿主 shell.run 上限 600000ms）。 */
const TIMEOUT_MS = {
  video_storyboard: 300_000,
  video_zoom: 300_000,
  video_storyboard_probe: 60_000,
  video_locate: 300_000,
  video_help: 10_000,
};
const WORKER = fileURLToPath(new URL('./worker/run.mjs', import.meta.url));

/** 把结果 JSON 折成工具回执文本：索引在前，图片路径在后（模型按需打开）。 */
function renderResult(result) {
  const parts = [result.text];
  if (result.images?.length) {
    parts.push('', '分镜图（用 read_file 打开查看）：', ...result.images.map((p) => `- ${p}`));
  }
  return parts.join('\n');
}

export default defineTianshuPlugin({
  id: 'video-storyboard',
  activate(host) {
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

          await host.workspace.write(jobFile, JSON.stringify({ tool, args, out: outDir, workspace: cwd }));
          await host.shell.run(`"${process.execPath}" "${WORKER}" --job "${cwd}/${jobFile}"`, {
            timeoutMs: TIMEOUT_MS[name],
          });
          const result = JSON.parse(await host.workspace.read(`${rel}/result.json`));
          if (!result.ok) return { content: `[${name}] ${result.error}`, isError: true };
          return { content: renderResult(result) };
        },
      };
    });
    return { tools };
  },
});
