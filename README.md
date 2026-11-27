# 微信 Codex

在微信 ClawBot 私聊中向本机 Codex 派任务，收发文字、图片、音频、视频和文件。开发者 Ace，MIT 开源。

[安装](#安装) · [更新](#更新) · [后台与卸载](#后台与卸载) · [验证情况](docs/verification.md) · [版本记录](CHANGELOG.md)

## 支持平台

| 平台 | Node.js | 后台 | 语音回复 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 22.19+ / 24 | 当前用户 LaunchAgent | 系统中文语音 |
| macOS Intel | 22.19+ / 24 | 当前用户 LaunchAgent | 系统中文语音 |
| Windows 10/11 x64 | 22.19+ / 24 | 当前用户任务计划程序 | Windows 中文语音包 |

Windows ARM64 和 Linux 暂未提供安装支持。自动化结果与手机实测范围见 [验证情况](docs/verification.md)。

## 功能

- 本人微信扫码授权，支持手机 PIN，凭证保存在本机。
- 独立模型、推理强度、工作目录、执行权限、人设和可选任务时限。
- 私聊连续会话、排队、停止任务、一次性权限审批。
- 图片输入、语音本地转写、视频画面采样与音轨转写、文件收发。
- 语音回复固定发送可播放的 MP3 附件，并保留文字。
- 独立“会话历史”入口，支持搜索、时间、当前会话标识和跳转。

目前使用范围为扫码绑定者本人私聊。微信接入资格、安全验证和服务规则以微信授权页面为准，本项目是独立的第三方适配。

## 安装

先安装 Node.js 和 Codex CLI，并登录 Codex。桌面端用于插件设置与历史界面。

```sh
npm install -g @openai/codex
codex login
```

从 GitHub 下载源码后，在项目目录执行。下面的命令同时适用于终端和 PowerShell。

```sh
git clone https://github.com/Ace-rising-sun/codex-weixin.git
cd codex-weixin
npm ci --ignore-scripts --no-audit --no-fund
node install.mjs
```

也可以在 [Releases](https://github.com/Ace-rising-sun/codex-weixin/releases) 下载源码包，解压后执行后两条命令。FFmpeg 和 CPU 推理预编译依赖由 npm 按平台安装。安装时需要联网下载依赖。

安装器先检查 Codex 登录，再注册本机插件和当前用户后台。源码的 `.mcp.json` 是可移植模板，机器专属 Node 路径写入私有安装目录，源码不会被安装器改写。保留源码目录，更新和运行依赖该目录；移动后重新运行安装程序。

重新打开 Codex，在“插件 → 微信 Codex”选择“打开设置”或“会话历史”。点击“扫码连接”，使用本人微信授权，手机要求时输入 PIN。

### Windows 准备

使用 Windows x64 版 Node.js 和 Codex CLI，保持 PowerShell 5.1、任务计划程序可用。后台以当前登录用户运行，登录 Windows 后启动。

语音合成需要系统中文语音。可在 Windows 设置的语言与语音选项中安装中文语音包。缺少语音包时会明确提示，并保留文字回复。安装不需要第三方语音 API Key。

CLI 自动定位 `codex.exe` 或 npm 安装的原生二进制。特殊安装可设置 `CODEX_WEIXIN_CODEX` 为真实可执行文件绝对路径后运行安装器。

### 默认设置

模型 `gpt-6.2-sol`，推理 `high`，工作目录为项目目录，只读权限，单轮不限时，单附件 20 MB。请在设置中选择要操作的目录和账号可用模型。工作目录写入权限可单独开启，额外权限通过微信审批。

## 更新

先等待微信任务结束，再执行。

```sh
git pull --ff-only
npm ci --ignore-scripts --no-audit --no-fund
node install.mjs
```

下载源码包的用户可将新版本解压到原目录，重新安装依赖并运行安装器。更新保留扫码绑定、用户设置、任务和历史。正在执行或排队时安装器会拒绝更新，避免中断任务。重新打开 Codex 加载新版入口。

## 媒体

| 类型 | 接收 | 发送 |
| --- | --- | --- |
| 图片 | 下载解密，作为 Codex 图像输入 | 真实图片文件 |
| 语音 | 微信转写优先，否则 SILK → WAV → 本地 Whisper | 系统语音合成或现有音频转 MP3 |
| 视频 | 保留原文件，采样六个画面，尝试音轨转写 | MP4 / H.264 / AAC |
| 文件 | 保存到本机，交给 Codex 按需读取 | 本地文件附件 |

语音识别首次下载 Whisper tiny 模型到私有缓存，约数十 MB，此后复用。音频不上传外部 ASR 服务。识别结果可能有误。视频采样无法代表未采样的内容。

单附件上限可设置为 1–100 MB，每条消息最多四个附件，每轮最多发送四个产物。回复中的本地 Markdown 图片或文件链接会被识别，代码示例里的路径会跳过。附件只允许从工作目录和私有媒体目录发送。

你可以直接说“分析这张图”“把报告发给我”“用语音回答”。Agent 产物协议见 [开发说明](docs/development.md)。

失败会说明原因并保留文字答案；状态为“已提交发送”表示接口调用完成，手机实收仍以客户端为准。投递不确定时不自动重发。

## 微信命令

- `/help` 查看命令
- `/status`、`/ping` 查看连接和队列
- `/stop` 请求停止当前任务，待 Codex 结束后再执行下一条
- `/new` 空闲时开始新会话
- `/history` 最近会话
- `/approve 123456`、`/reject 123456` 回应两分钟内有效的一次性权限请求

桌面端占用同一个 Codex 会话时，机器人可能无法写入，会明确提示。可释放桌面端会话，或在微信 `/new` 开始新的上下文。

## 后台与卸载

```sh
node manage.mjs status
node manage.mjs stop
node manage.mjs start
node manage.mjs uninstall
```

卸载命令移除插件、市场注册和自启动后台，保留用户数据，方便重装。仅在 Codex 插件页卸载时，独立后台仍可能运行，完整卸载请执行上述命令。

私有数据目录如下。

- macOS 为 `~/Library/Application Support/Codex Weixin/`
- Windows 为 `%LOCALAPPDATA%\Codex Weixin\`

`account.json` 保存登录凭证，`settings.json` 保存配置，`state.json` 保存任务与会话，`media/` 保存附件，`models/` 保存本地识别模型，`daemon.log` 保存诊断。Windows 额外保存命名管道控制凭证 `control.json`。这些文件不进入源码和发布包。

可先在设置点击“断开微信”删除登录凭证。附件保留供历史会话读取，暂不自动清理。需要彻底清除数据时，先卸载后台，再自行删除对应私有目录。

## 开发与发布

```sh
npm run check
npm test
npm run test:platform
npm run package
```

`test:platform` 在隔离目录注册真实 Codex 插件，测试用户后台启停、控制通信、系统语音与卸载，需要系统服务权限和已安装的 Codex CLI。它不会连接真实微信账号。

CI 覆盖三种操作系统架构与 Node.js 22、24，共六组。推送 `v<package.json 版本>` 标签后，发布流程检查版本、运行测试并生成源码包和 SHA256 校验文件。

## 许可与来源

项目源码采用 [MIT](LICENSE)。微信协议参考腾讯公开的 iLink 文档，设计参考 DSH 微信插件。模型、FFmpeg 和其他运行依赖各自保留原有许可，详见 [第三方声明](THIRD-PARTY-NOTICES.md)。发布包提供源码，依赖在使用者机器通过 npm 安装。
