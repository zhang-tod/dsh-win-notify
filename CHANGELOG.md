# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-07

First public release: Windows native toast notifications for DSH, delivered from
the **host** process rather than the renderer, so closing the tab or the whole
browser does not stop them.

<!-- TODO(core + verify): 逐条事件清单待 core 定稿、verify 独立复验通过后补入。
     预期覆盖：回合完成 / 子代理完成 / 后台任务(job)完成 / 模型提问（带选项预览）
     / 权限审批 / plan-review。
     ⚠️ 每条实测通过前不得写入。已知后台 job 完成通知存在缺陷（PLAN-V2 P0-1），
     修复并复验前不得进入本清单；点击通知的跳转行为同样待 P0-2 复验。 -->

[0.1.0]: https://github.com/zhang-tod/dsh-win-notify/releases/tag/v0.1.0
