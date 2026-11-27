# 开发说明

`runtime/weixin.mjs` 负责微信消息，`media.mjs` 处理加解密与上传下载，`media-flow.mjs` 连接媒体和 Agent，`daemon.mjs` 管理队列与 Codex。`platform.mjs` 和 `service.mjs` 管理系统差异。`settings.mjs` 提供 MCP 设置与历史入口。

本机凭证与任务数据使用 `CODEX_WEIXIN_HOME` 指定的私有目录。测试在隔离目录运行，禁止以真实账号数据作为 fixture。`CODEX_WEIXIN_CODEX` 可指定 CLI，`CODEX_WEIXIN_FFMPEG` 可指定已有 FFmpeg。

最终回复可用以下指令发送真实产物。指令行会被移除，其他文字保留。

```text
WEIXIN_MEDIA: {"path":"/absolute/path/report.pdf","kind":"file"}
WEIXIN_MEDIA: {"path":"C:\\workspace\\report.pdf","kind":"file"}
WEIXIN_VOICE: {"text":"这是要朗读的内容"}
```

`kind` 支持 `auto`、`image`、`voice`、`video`、`file`。语音文本单条最多 500 字。按文件发送较长音频时可用 `file`。

发包前运行 `npm run check`、`npm test`、`npm run test:platform`，再从 Git 克隆中运行 `npm run package`。源码包从当前提交的发布清单生成。工作区中的依赖、微信数据、模型缓存和日志留在本机，归档使用固定所有者信息并排除文件系统扩展属性。FFmpeg 二进制不进入源码包，由安装者通过 npm 获取；若改变分发方式，应先核对所用 FFmpeg 构建的许可与源码义务。

版本同时更新 `package.json`、锁文件、插件清单和运行时元信息。CI 检查前三者一致，标签发布检查 `v` 前缀的版本一致。跨平台 CI 成功后再标记版本发布。
