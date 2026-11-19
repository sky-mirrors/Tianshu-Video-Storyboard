# 发布信息（数据用途 / 外部服务与费用 / 版本变更）

> 这份是**提交到插件库时填的三段文案**，内容按本仓库的实现如实写；不要改写成本仓库没做的事。
> 发行包与提交参数见文末。

## 1. 数据用途

本插件在本机运行，把用户指定的视频转成分镜图与文字索引。按实现说明它读了什么、写了什么、发出去了什么。

**读取范围**

- **用户指定的视频文件**：用 ffmpeg/ffprobe 解码、抽帧、测量音频响度。路径可以是本机任意位置，也可以是 `http(s)` 链接（后者经 yt-dlp 下载到临时目录）。
- **可选的转写输入**：`transcriptFile` 传入的 SRT/JSON；或视频自带的字幕轨。没有字幕轨且后文「外部服务」中的 ASR 未配置时，转写会被标成「没有做」，而不是「视频没说话」。
- **可选的用户配置**：`$DSH_HOME/asr.json`（`DSH_HOME` 未设时用 `~/.dsh`）里的 ASR 配置，以及宿主密钥库里本插件自己的 `asrKey`（`host.secrets`，按账号与插件隔离，插件进程无法读取其存储文件）。
- 插件**不读取**与本任务无关的文档、聊天记录、其他插件的数据或用户账号凭据。

**写入范围**

- 分镜图、`result.json`、`storyboard.evidence.json` 落在**当前项目目录**的 `.tianshu-video-storyboard/<runId>/` 下。
- 扫描缓存与转写缓存落在系统的用户缓存目录：Windows 为 `%LOCALAPPDATA%\dsh-video-storyboard\cache`，其他平台为 `$XDG_CACHE_HOME/dsh-video-storyboard`（代码见 `src/storyboard/cache.js:57-62`）。缓存只含解码统计与转写结果，不含原始视频拷贝。
- 工具回执（时间码索引、图片绝对路径、成本估算）会进入当前会话记录，这是宿主对所有工具的统一行为。

**离开本机的数据**

只有在**用户自己配置了云端 ASR** 时才会发生：插件把该窗口的音频片段发往用户配置的 `baseUrl`（默认 `https://api.siliconflow.cn/v1`，见 `src/storyboard/asr.js:125`）做语音识别。发出的内容仅为此段音频与可选的热词；不发视频、不发文件名、不发会话内容。`baseUrl` 指向本机地址（`127.0.0.1`/`localhost`）时**不需要 key 也不出网**（`asr.js:69/86`）。用户可以用 `transcript:"off"` 完全关闭这条路径，或用 `transcriptFile` 直接喂一份转写、不触网。

**不收集任何遥测**：无统计上报、无崩溃上报、无设备指纹（仓库内 `telemetry`/`analytics` 零命中）。

## 2. 外部服务与费用

| 项 | 是否必需 | 说明 |
|---|---|---|
| **ffmpeg / ffprobe** | 必需 | 用户自行安装的本地程序，以**独立进程**调用（argv，不经 shell），不打包、不链接、不随本仓库分发。ffprobe 缺失时退回 `ffmpeg -i` 的解析（`src/storyboard/probe.js`）。 |
| **yt-dlp** | 仅链接输入时 | 用户自行安装；插件不内置下载能力。只处理 `http(s)` 输入。 |
| **云端 ASR（默认 siliconflow）** | 可选 | **这是唯一可能产生费用的外部服务**，且费用由用户向该服务商支付，本插件不代收、不加价、无内购、无订阅。价格以用户所选服务商的公开定价为准；不配 key 就不产生调用。 |
| **本机 ASR 服务（如 sherpa-onnx / FunASR）** | 可选 | 用户自建，无 key、无网络、无费用。`baseUrl` 指向回环地址即为该路径。 |
| **插件本体** | — | 免费，无试用期限制、无按次计费、无账号绑定。 |

本插件自身不访问任何固定的第三方端点：不加载远程脚本、不检查更新、不查询许可服务器。

## 3. 版本变更说明（0.7.6）

本版本是 TPI 2.0 插件面向插件库的发行版本。

**新增**

- **ASR key 走宿主密钥库**：`video_storyboard` / `video_zoom` / `video_locate` 在需要台词且调用方未显式传 `asrKey` 时，从 `host.secrets('asrKey')` 取值注入解码进程；取不到时不静默降级，而是通过 `host.notifications.show` 提醒一次（同一会话只弹一次）并明确标注「没有做转写」。设置入口是 `设置 → 插件 → 视频分镜设置`（`views/settings.html`），页面只认一个名字 `asrKey`，不接受任意 key 名。
- **发行打包脚本** `scripts/pack-release.mjs`：按官方手动打包流程生成 `xiaosi.release.json` + `xiaosi.contents.json` 与 ZIP32 包（自写 ZIP writer，保证包内路径用 `/` 分隔、时间戳固定以保证可复现字节）。

**清单变更**

- `capabilities` 增加 `secrets`、`notifications`；`contributes.ui` 增加 `settings` 页。
- `engines.tianshu` 由 `>=4.1.0` 改为 `>=4.0.5`（TPI 2.0 发行要求的兼容下限）。

**许可**

- 自有层改为 **MIT**；移植自上游 `SAOS-3624/dsh-video-storyboard` 的部分（`src/storyboard/**`、`bin/`）仍为 **Apache-2.0**，全文保留在 `LICENSE-APACHE` 与 `NOTICE`。

**已知限制**

- 单次调用 300 秒上限，长片请用 `from` + `segment` 分窗读。
- 未在 macOS / Linux 实测；`platforms` 声明的三平台中只有 `win32-x64` 有真机记录。
- 仓库内 `npm test` 的实测记录为 550 用例 / 527 通过 / 8 跳过 / 15 失败，失败分三类（依赖未移植的宿主层、断言 `dsh.plugin.json` 元数据、本机 ffmpeg 构建缺能力），没有指向已移植算法层。

## 附：提交参数（发行包固定字段）

```
release_id    = rel_video_storyboard_076
publisher_id  = b226234e-c3c8-4223-9e58-7e9fadbb5bea
plugin_id     = video-storyboard
version       = 0.7.6
compatibility = tpi "2.0" / core ">=4.0.5" / win32-x64, darwin-arm64, linux-x64
lane          = official_reviewed
license       = MIT AND Apache-2.0（自有层 MIT，移植面 Apache-2.0；见 LICENSE / LICENSE-APACHE）
source_url    = https://github.com/sky-mirrors/Tianshu-Video-Storyboard
```

`artifact_sha256` 以打包后重新计算的结果为准（写死会形成「改文档 → 重新打包 → 哈希又变」的自指循环）。

```bash
node scripts/pack-release.mjs --release-id rel_video_storyboard_076 \
  --publisher-id b226234e-c3c8-4223-9e58-7e9fadbb5bea \
  --source-commit <当前提交的完整 40 位小写 hash> \
  --platforms win32-x64,darwin-arm64,linux-x64
```
