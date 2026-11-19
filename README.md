# video-storyboard（天枢 TPI 2.0 插件）

把一段视频变成**可以引用的分镜图**：一个镜头一格，格子密度跟随切点密度（1/1 … 1/8），
行内打包成尽量少的图，并附一份能引用到秒的时间码索引和一张可覆盖的档位表。

移植自 [`SAOS-3624/dsh-video-storyboard`](https://github.com/SAOS-3624/dsh-video-storyboard)
（Apache-2.0，见 `LICENSE` / `CREDITS.md` / `NOTICE`），按天枢 **TPI 2.0** 的隔离插件规范重接入口层。

## 五个工具

| 工具 | 用途 | 出图 |
|---|---|---|
| `video_storyboard` | 全片或一段的概览宫格 + 时间码索引 | 是 |
| `video_zoom` | 某一段/某一格的近距离重看（格少、每格大） | 是 |
| `video_probe` | 只读容器头：时长/分辨率/帧率/编码，不花图 token | 否 |
| `video_locate` | 纯文本定位：那句话在第几分钟 | 否 |
| `video_help` | 工具手册：token 成本、策略、档位、切点调参 | 否 |

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

## 自检

不装进天枢也能验证胶水层（需要真实视频 + ffmpeg）：

```bash
FFMPEG_PATH=/path/to/ffmpeg node scripts/tpi-host.smoke.mjs video_probe '{"input":"D:/clip.mp4"}'
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
