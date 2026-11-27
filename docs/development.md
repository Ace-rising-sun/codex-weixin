# 开发说明

`runtime/weixin.mjs` 负责微信消息，`media.mjs` 处理加解密与上传下载，`media-flow.mjs` 连接媒体和 Agent，`daemon.mjs` 管理队列与 Codex。`outbox.mjs` 负责持久化后逐条回传，`tasks.mjs` 管理账号标识、短编号、状态与重启恢复，`memory.mjs` 管理用户主动记忆。`platform.mjs` 和 `service.mjs` 管理系统差异。`settings.mjs` 提供 MCP 设置与历史入口。

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


## 执行、回传与记忆边界

执行 worker 依次处理输入媒体、冻结的记忆快照、Codex 回合及产物准备。结果和附件快照与初始 outbox 条目一起保存成功后才启动回传 worker；下一个 Codex 回合可在上传期间运行。回传 worker 按入队顺序串行发送，逐附件、逐段文字在提交前标记 sending、发送接口成功响应后标记 sent；不确定结果标记 unknown 且不自动重试。重启只继续确定尚未开始的 pending 回传，不重跑 completed/interrupted 回合，不继续 sending/unknown 条目。`/result` 是读取，明确附件重发是新的 outbox 尝试，保留原尝试状态。

对安装/卸载公开的忙碌状态包含执行、排队、回传及待完成的记忆 I/O；安装/停止/卸载沿用该状态。回传用自己的取消信号，`/stop` 不会误取消前一个任务的上传。关闭进程前将活动回传标为 unknown。入站命令、设置与确认状态由后台 mutation 队列串行处理，记忆读写还在 MemoryStore 内串行并以同目录临时文件 rename 原子提交；不提供多实例共享同一自定义记忆目录的写入保证。

记忆是微信通道的独立 application context，不加入宿主全局 Codex 配置，也不从附件或助手输出自动提取。每轮保留精选条目的正文快照供 `/memory used` 回查；删除只影响未来精选，不改写已有聊天与任务审计。本人语音改动先记录待确认操作，文字确认后将操作去重标识与条目一起保存。备份携带账号哈希和去重记录，不含机器人凭证；恢复拒绝跨账号和同编号不同内容。常驻最多 4 条，精选最多 8 条且格式化内容不超过 1200 字符。

发布前检查源码、所有新增 fixture 和归档：只能使用合成账号、合成记忆和临时目录。开发和平台烟测必须使用隔离 CODEX_HOME / CODEX_WEIXIN_HOME，不能停止真实微信服务。
