# video-storyboard（天枢 TPI 2.0 插件）

把一段视频变成**可以引用的分镜图**：一个镜头一格，格子密度跟随切点密度（1/1 … 1/8），
行内打包成尽量少的图，并附一份能引用到秒的时间码索引和一张可覆盖的档位表。

移植自 [`SAOS-3624/dsh-video-storyboard`](https://github.com/SAOS-3624/dsh-video-storyboard)
（Apache-2.0），按天枢 **TPI 2.0** 的隔离插件规范重接入口层。

## 来源与致谢

- **上游**：SAOS-3624/dsh-video-storyboard —— Apache-2.0。
  本仓库的 `src/storyboard/**` 算法层与 `bin/` CLI 基本原样保留（唯一实质改动是 `probe.js`
  增加了 ffprobe 缺失时退回 `ffmpeg -i` 的解析），原文与 `NOTICE` 一并留在仓库里。
- **上游的上游**：那个项目自己也站在更多人肩膀上 —— 设计参考的插件、社区报告与修复、
  测试素材作者的完整名单在 CREDITS.md。
- **本仓库新增**：TPI 2.0 入口（`index.js` / `tpi.js` / `lib/`）、宿主侧 `worker/`、
  `views/` 界面、`scripts/` 打包与自检、以及 ASR key 走宿主密钥库的集成 —— 这些由本仓库作者编写。

## 许可

分成两层，因为移植面不是自有代码：

| 范围 | 许可 | 全文 |
|---|---|---|
| 本仓库自有代码（`index.js`、`tpi.js`、`lib/`、`worker/`、`views/`、`scripts/`，以及在上游文件上做的改动） | MIT | LICENSE |
| 移植自上游的部分（`src/storyboard/**`、`bin/`） | Apache-2.0 | LICENSE-APACHE + NOTICE |

提交到插件库时填的**数据用途 / 外部服务与费用 / 版本变更说明**三段文案在 PUBLISH.md，按实现如实写，可直接复制。


## 六个工具

| 工具 | 用途 | 出图 |
|---|---|---|
| `video_storyboard` | 全片或一段的概览宫格 + 时间码索引 | 是 |
| `video_zoom` | 某一段/某一格的近距离重看（格少、每格大） | 是 |
| `video_storyboard_probe` | 只读容器头：时长/分辨率/帧率/编码，不花图 token | 否 |
| `video_locate` | 纯文本定位：那句话在第几分钟 | 否 |
| `video_subtitles` | 把硬字幕逐条裁下来纵向拼成一张长图 | 是 |
| `video_help` | 工具手册：token 成本、策略、档位、切点调参 | 否 |

### 为什么 `video_probe` 叫 `video_storyboard_probe`

`~/.rivet/plugins/media-toolkit`（TPI 1.0，前一个移植的插件）也声明了 `video_probe`。
宿主对**跨 TPI 版本**同名工具怎么处理，我没能从 runtime 代码或日志取证到明文行为，
所以按保守方案在插件边界改名：上游 `src/storyboard/tool-spec.js` 与它的 49 个测试
保持原样，改名只发生在 `index.js` 的 `RENAME` 表。全量扫描当前安装位共 15 个工具名，零冲突。

## 安装

天枢 4.1.0 起支持 TPI 2.0 隔离插件。把本目录放进插件目录后重启会话：

```
~/.rivet/plugins/video-storyboard/
  ├── tianshu.plugin.json   清单（$tpi 2.0 / capabilities / permissions）
  ├── index.js              入口：注册工具、写作业文件、收结果
  ├── tpi.js                SDK 握手（只在宿主内可用）
  ├── lib/schema.js         参数表 → JSON Schema
  ├── worker/run.mjs        宿主侧进程：真正跑解码、抽帧、拼图
  ├── src/storyboard/       上游算法层（原样保留）
  ├── src/ocr_bridge.py     硬字幕 OCR 桥（detail=high 时启用，缺失会报 not found）
  └── bin/                  上游 CLI（可选，便于本地排查）
```

插件声明了三项能力：`tools`、`workspace`（读+写）、`shell`（run）。
`workspace` 用于在工作区里交换 `job.json` / `result.json` 并落地图片；
`shell` 用于在宿主进程里跑 worker（原因见下）。

## 为什么要有 worker

TPI 2.0 的插件跑在隔离沙箱里（Windows 上是 AppContainer）：**只有插件目录可读、插件数据目录可写**。
而 ffmpeg 要读任意视频、要往临时目录写帧，这些在沙箱里做不到。

宿主给的 `shell.run` 在**宿主进程**里执行，不受沙箱文件白名单限制，所以：

```
插件（沙箱内）                      宿主进程
─────────────                      ─────────
workspace.write job.json  ──►  shell.run node worker/run.mjs --job ...
                                    ├─ probe / scan / cuts / frames / sheet
                                    └─ 写 storyboard.png + result.json
workspace.read result.json ◄──
返回「文本索引 + 图片绝对路径」
```

算法层（`src/storyboard/**`）是上游原封不动的代码，一行 ffmpeg 调用都没改。

## 依赖

- **ffmpeg**：必需。查找顺序见 `src/storyboard/binaries.js`：
  `FFMPEG_PATH` / `DSH_FFMPEG_PATH` → `$DSH_HOME/tools/ffmpeg/bin` → `$DSH_HOME/bin` →
  工作区 `tools/ffmpeg/bin` → `PATH`。
- **ffprobe**：可选。找不到时自动退回 `ffmpeg -i` 的 stderr 解析（`probe.js` 的
  `parseFfmpegInfo`），时长/宽高/帧率/编码/音轨/字幕轨都能拿到。这条降级路是本移植新增的。
- **ASR key**：可选。没有 key 时 `video_locate` 会明确说明「没有转写」，不会谎称「视频没说话」。
  也可以直接用 `transcriptFile` 喂一份 SRT/JSON。
- **yt-dlp**：只有 `http(s)` 链接输入才需要。

## 与上游的差异（只列真正改过的）

| 位置 | 差异 | 原因 |
|---|---|---|
| `index.js`、`tpi.js`、`lib/schema.js` | 新增 | DSH 的 `apply(ctx)` 换成 TPI 2.0 的 `defineTianshuPlugin({ activate(host) })`；`parameters` → `inputSchema` |
| `worker/run.mjs` | 新增 | 把「跑管线 → 存图 → 出文本索引」搬进宿主侧进程，绕开沙箱文件白名单 |
| `src/storyboard/probe.js` | 新增 `parseFfmpegInfo` + `probeVideo` 的 `ENOENT` 降级 | 用户机器常常只有 `ffmpeg` 没有 `ffprobe` |
| — | 未移植 `src/index.js`、`src/tools/*`、`src/settings/*`、`src/storyboard/{register,host-asr,offload}.js` | 它们全都依赖 DSH 的 `ctx.tools.register` / `ctx.attachments` / `webServer`，天枢没有对应物 |

## 图片怎么被看到

TPI 2.0 的工具回执只有 `content` 字符串，没有 DSH 的 attachments 通道。所以工具返回**图片的绝对路径**，
由模型用读文件的方式打开：

```
分镜图（用 read_file 打开查看）：
- D:\work\.tianshu-video-storyboard\storyboard-...\storyboard.png
```

## 已知限制

- 单次调用上限 **300 秒**（宿主 `shell.run` 上限 600 秒仍在插件侧收窄到 300）。
  长片请用 `from` + `segment` 分段读，而不是一次全片。
- 没有设置页（上游的 `src/settings/**` 依赖 DSH 的 webServer）。用户级配置读
  `$DSH_HOME/video.json`（`DSH_HOME` 未设时用 `~/.dsh`），与上游同一份 schema。
- `voice`/ASR 走 `src/storyboard/asr.js` 的既有后端（需要 key 或本地服务），不做宿主侧模型注入。

## 移植决策台账（扔 / 留 / 补 / 特色）

**扔掉**（上游有、这里不需要）：

| 模块 | 行数 | 为什么扔 |
|---|---|---|
| `src/settings/**`（config/deps/server/page.js/page.html/token） | 721 | 依赖 DSH 的 `webServer` 注入；天枢 TPI 2.0 没有这个能力。配置改读 `~/.dsh/video.json`，无文件则用代码默认值 |
| `src/storyboard/offload.js` | 225 | 依赖 DSH 的 `session/event` + `sessionController`，用于把更早的图从**对话历史**里省略。本插件图不进对话历史（落工作区），这套机制无对象 |
| `src/storyboard/host-asr.js` | 170 | 依赖 DSH 的 `speechToText` 服务注入；天枢没有该能力，ASR 走原有的 `asr.js`（自带 key/本地服务） |
| `src/storyboard/register.js` | 40 | DSH 的 `ctx.tools.register` 注册入口，已被 `index.js` 的 TPI 工具表取代 |
| `src/index.js`（DSH 入口） | 254 | 含 cordis `inject` 就绪门、`apply` 看门狗、图片 offload 接线，全部是 DSH 宿主语义 |
| `src/storyboard/index.js`（barrel） | 43 | 全仓零调用方（可达性分析确认后删除） |

**保留**（虽不在这条链路上，但有独立价值）：

| 模块 | 为什么留 |
|---|---|
| `bin/`（7 个 CLI） | 终端里仍可手动跑（插件目录在 `~/.rivet/plugins/`，任意 shell 可达），是排障与批量出图的入口 |
| `src/storyboard/segments.js` | 上游 `segments.test.mjs` / `e2e.scan.test.mjs` 直接 import |

**补全**（上游写了却没接通，这里接上）：

| 项 | 上游状态 | 本插件 |
|---|---|---|
| `video_subtitles` 的 `times` 参数 | `subtitle-strip.js` 支持、`tools/subtitles.js` 读 `args.times`，但 schema 没声明 → 任何宿主都会丢弃（DSH 注释原话："schema 没声明的参数会被直接丢掉"） | 参数表补上 `times: number[]`，实测按 `[1,3,5,7]` 精确对齐（不再是均匀抽样） |
| `ffprobe` 缺失 | 直接失败（`spawn ffprobe ENOENT`） | `probe.js`、`subtitle-strip.js` 两处都退回 `ffmpeg -i` |

**天枢特色**（上游做不到、这里做得到）：

| 特色 | 说明 |
|---|---|
| 沙箱安全模型 | 插件跑在 AppContainer + Node `--permission` 里（只读插件目录、只写数据目录），真正解码交给宿主侧 `worker/run.mjs` —— 上游是同进程无隔离 |
| 结果以路径交付 | 图落工作区、回执给绝对路径，由模型 `read_file` 打开；不占对话历史的每轮上下文 |
| 串行执行 | 未声明 `concurrencySafe` → 宿主串行调度。上游 `subtitle-strip.js` 自己写着"并发裁剪必崩"，串行对视频重活更稳 |

## 天枢 UI 面板（分镜库）

TPI 2.0 给了 `views` / `panels` / `commands` / `statusItems` 四个 UI 贡献点，这里用它们做了三件事：

| 功能 | 实现 | 文件 |
|---|---|---|
| **分镜库面板** | 侧边面板列出最近 20 次运行（文件名 / 格数 / 张数 / 耗时），卡片尽量贴图；贴不出来时只留文字信息 | `views/library.html`、`views/library.js`、`views/view.css` |
| **进度反馈** | 慢工具（storyboard / zoom / subtitles）开始与结束各推一条 `host.ui.setStatus('job', ...)`，manifest 里声明了 `statusItems` | `index.js` |
| **多图分页** | 一次回执最多列 4 张图的路径，其余只报数量与目录 —— 两小时的片子能出十几张，全列会把回执照废 | `lib/render.js` 的 `renderResult` / `IMAGE_PAGE`（有 `test/render.test.mjs` 盯着分页边界） |

协议按官方 TPI 2.0 示例实现（`shen/release-audit/tpi2-demo/views/status.js` 实读）：

- 视图 → 宿主：`parent.postMessage({ tpi:'view', type:'resize', height })`
- 宿主 → 视图：`event.data.tpi === 'host'`，`type:'hello'` 携带 `context`（作为工具结果卡片打开时是 `context.tool` / `context.result`）
- 请求-应答：视图 `{tpi:'view', type:'ask', requestId, payload}` ↔ 宿主 `{tpi:'host', type:'answer', requestId, value}`

**图片预览是尽力而为**：宿主可能把视图跑在带 CSP 的 iframe 里，`file://` 会被拦。所以卡片主体一定是文字
（文件名 / 格数 / 耗时 / 路径），`<img>` 加载失败就隐藏——不赌未核实的渲染行为。

面板读的是插件进程里的 `library` 数组：视图与插件同在一个 sandbox child，不需要落盘共享状态。

## 契约符合性（TPI 2.0）

条款不是抄文档，是从宿主 runtime 的实现里读出来、再用宿主自己的校验器跑一遍：

```bash
node scripts/contract-check.mjs          # 37 条，当前 37/37 PASS
```

覆盖范围（每条都能指到宿主实现）：

| 条款 | 依据 |
|---|---|
| `$tpi` ∈ 宿主 `TPI_SUPPORTED_VERSIONS`、`kind`、id/version 格式、description ≤500、`engines.tianshu` 必填、能力↔权限配对 | `chunk-CIXVI7BW.js` 的 `parseTpiManifest`（zod + superRefine） |
| 文件存在、非 legacy 格式 | `chunk-JHS3EY74.js` 的 `readTpiManifest` |
| 工具 `name` ≤64 且 snake_case、manifest description ≤200 | 同上 zod schema |
| 运行时 description ≤**2000**、`timeoutMs` ≤600000（逐个工具，读 `index.js` 的 `TIMEOUT_MS` 表） | `chunk-RARWTZDC.js` 的 `toolDeclaration`（`text(0x7d0)` / `max(0xa*0xea60)`） |
| 目录内无符号链接（`nlink` 必须为 1） | 同文件的 `assertPrivateTree` |
| **manifest 声明与运行时注册逐名一致** | `scripts/real-host-check.mjs` 会打印两份清单并比对 |

一个实测细节：上游工具描述是 882 / 412 / 319 / 395 / 193 字符，全部落在运行时上限
2000 之内、但远超 manifest 的 200——所以 manifest 里用的是短描述（25/20/60/14/33 字符），
两套描述各管一处，不能混用。

## 真机测试（Windows 10 · 天枢 4.1.0 · 宿主进程 tianshu-desktop 33824）

不是 mock：直接用宿主 runtime 自己的三个文件跑通。

| 步骤 | 用什么 | 结果 |
|---|---|---|
| 1. 部署到安装位 | `~/.rivet/plugins/video-storyboard/`（838K） | ✔ |
| 2. 清单校验 | 宿主自带 `readTpiManifest` + `parseTpiManifest`（不是第三方 jsonschema） | `ok = true`；`$tpi 2.0` 落在 `TPI_SUPPORTED_VERSIONS = ['1.0','2.0']` |
| 3. 真沙箱绑定 | 宿主 `bindIsolatedTpiPlugin`（Windows **AppContainer** + Node `--permission` 白名单：`readPaths=[插件目录]`、`writePaths=[数据目录]`） | 返回 `{pluginId, tools(5), hooks, stop, dispose}` |
| 4. 沙箱内调用 | `video_storyboard_probe` | 232ms，`isError=false`，返回 8.06s / 1280×720 / 24fps / h264 |
| 5. 沙箱内出图 | `video_storyboard` | 2404ms，`isError=false`，`storyboard.png`（756×499，4 格）落到工作区 |

真机抓到 mock 掩盖的两条缺陷（已修，`index.js` + `worker/run.mjs`）：

1. **宿主的 `workspace.write` 不创建父目录** —— 原来把 `job.json` 写进 `.tianshu-video-storyboard/<runId>/`，
   真机直接 `ENOENT`。现改为写在**工作区根**（worker 读完即删），子目录由 worker 自己建。
2. **输出目录同样没人建** —— worker 只在写 `result.json` 时才 `mkdir`，pipeline 已经把 PNG 写进去了，
   真机报 `[image2] Could not open file : ...\storyboard.png`。现改为 worker 一启动就建 `out`。

`scripts/tpi-host.smoke.mjs` 也同步删掉了 `mkdir(dirname)`——留着它就是让这两类缺陷在 mock 里永远不复现。

真机检查可复跑（用的是宿主自己的 runtime，不是 mock）：

```bash
node scripts/real-host-check.mjs                    # 只校验清单 + 绑沙箱
FFMPEG_PATH=/path/to/ffmpeg \
  node scripts/real-host-check.mjs video_storyboard_probe '{"input":"D:/clip.mp4"}'
```

它 import 的是 `Tianshu\rivet-runtime\chunk-JHS3EY74.js`（`readTpiManifest`）、
`chunk-CIXVI7BW.js`（`parseTpiManifest`）、`chunk-RARWTZDC.js`（`bindIsolatedTpiPlugin`）；
`shell.run` 用本地 bash 代跑（契约相同，但不是宿主那一份实现）。
数据目录留在系统临时目录下（AppContainer 给它的 ACL 让宿主删不掉，属预期）。

真机上 6 个工具全部跑过一遍：`video_storyboard_probe` 263ms、`video_storyboard` 2404ms（出图 524622 字节）、
`video_subtitles` 1300ms（3 条字幕带，`times` 对齐）、`video_help`、`video_zoom`（`from/to` 与 `cellId` 两条路径）、
`video_locate`（无转写时给降级说明，750ms）。
边界同样正确：空 `input` 与 `maxFrames: 10001` 都在 3ms 内被插件侧拒绝，没有落到 worker。

**一个真机才会遇到的坑**：`cells.json` 只保留最近 12 个文件的记录（`cells.js` 的 `MAX_FILES`），
跑一次 `npm test` 就会把它填满 `dsh-pipe-*` 临时路径，把真实文件的 cell 表挤掉——
之后 `video_zoom({cellId})` 会报 `no cell map recorded`。那时改用 `from/to`，
或重新跑一次 `video_storyboard` 即可。

## 自检

不装进天枢也能验证胶水层（需要真实视频 + ffmpeg）：

```bash
FFMPEG_PATH=/path/to/ffmpeg node scripts/tpi-host.smoke.mjs video_storyboard_probe '{"input":"D:/clip.mp4"}'
FFMPEG_PATH=... node scripts/tpi-host.smoke.mjs video_storyboard '{"input":"D:/clip.mp4","transcript":"off"}'
```

它用假宿主按 TPI 2.0 的 `host` 契约跑一遍：写 `job.json` → `shell.run` → 读 `result.json`。
放在 `scripts/` 而不是 `test/`，是因为 `node --test` 会把 `test/` 下每个文件当成一个测试跑。

上游自带的 49 个测试文件**已收进 `test/`**（`npm test` 即 `node --test`，会跑全部）。
覆盖已移植算法层的 49 个文件里 **36 个零失败**（含 `asr-lifecycle`、`asr-local`、`asr`、
`audio-rhythm`、`binaries`、`cells`、`scan`、`sheet`、`tiers`、`pack`、`probe`、`transcript-pass` 等）；
另 8 个整文件因 import 未移植模块无法加载，5 个文件（`audio`、`provenance`、`pipeline`、
`schema-audit`、`probe-cli`）可加载但含失败用例。本轮实测 550 个用例：
**527 通过 / 8 跳过 / 15 失败**，失败分三类，没有一项指向算法层：

| 失败源 | 数量 | 原因 |
|---|---|---|
| 整文件 import 失败 | 8 | 依赖未移植的 DSH 层（`src/settings/*`、`src/tools/shared.js`、`src/storyboard/{register,host-asr,offload}.js`）；`pipeline.test.mjs` 另有 2 处动态 `import('../src/index.js')`，主体用例可跑 |
| DSH 元数据断言 | 4 | `schema-audit` ×3 与 `probe-cli` 校验 `dsh.plugin.json`、`package.json` 的 bin 注册 |
| 本机 ffmpeg 构建缺能力 | 3 | 音频 e2e 用 `anullsrc=...:duration=`（本机构建无该选项）；极静素材测试裸调 `'ffmpeg'`（不在 PATH）；`N-92722-...` nightly 版本号不匹配语义版本正则 |

补齐 `src/ocr_bridge.py` 后，`ocr.test.mjs` 由 17/19 变 19/19（含 #39 的回归护栏）。
上面 15 条红是**已知且已归因**的，不是待修缺陷；换一台装标准 ffmpeg（版本号形如 `6.1.1`）
并把 ffmpeg 放进 PATH 的机器上，第三类会自动变绿。

清单结构可以自己校验（TPI 2.0 registry schema）：

```bash
python -c "import json,jsonschema;jsonschema.validate(json.load(open('tianshu.plugin.json')),json.load(open('manifest-v2.json')))"
```
