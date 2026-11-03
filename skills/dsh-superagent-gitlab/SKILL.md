---
name: dsh-superagent-gitlab
description: 在配置的 GitLab CE 项目中读取 Issue/MR、提交分支和 MR、绑定工单及回传结果。适用于 GitLab 15.9 REST v4。
---

# GitLab 项目操作

本部署使用 GitLab。使用环境中提供的 glab 包装器和已配置的代理身份。
不要调用 gh，不要读取、输出或另行传递 Token。
所有操作限定于 $DSH_SUPERAGENT_GITLAB_HOST 上的 $DSH_SUPERAGENT_GITLAB_PROJECT。

先读取触发消息和工单授权。遵循目标仓库的 AGENTS.md。
通过 glab api --hostname "$DSH_SUPERAGENT_GITLAB_HOST" "projects/$DSH_SUPERAGENT_GITLAB_PROJECT_ID/..." 使用 REST v4。
GitLab 15.9 试点不依赖 GraphQL 或新版本合并功能。
读取上下文可以使用 orchestrator_read 的 gitlab/issues/<iid>、gitlab/merge_requests/<iid> 及其 /notes/<page> 资源。
Issue 与 MR 的 IID 不共享命名空间。线程分别为 gitlab:issue:<iid> 和 gitlab:mr:<iid>。

在为工单准备的独立工作目录中修改代码，分支最后一段必须为 $DSH_SUPERAGENT_NAME。
提交使用仓库指令指定的作者；没有指定时，使用 $DSH_SUPERAGENT_GITLAB_ACCOUNT 和 $DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL。
推送分支后通过 POST projects/<id>/merge_requests 创建 MR。必要字段为 source_branch、target_branch、title、description。
默认目标分支是 $DSH_SUPERAGENT_GITLAB_BRANCH。
MR 描述须说明改动、验证和限制。UI 改动需要真实的前后证据。
不要自动关闭来源 Issue。

创建或接手 MR 后，调用 orchestrator_report 并传 mr_iid，绑定后再报告 ready。
没有 MR 时省略 mr_iid。不要用 pr_number 传 GitLab MR。
只允许绑定来源 MR，或代理在该项目内使用工单分支创建的 MR。
ready 表示已交付待审。MR 合并或关闭后由来源轮询更新工单状态。
试点中不得合并、审批、开启自动合并或修改保护分支规则。由人合并 MR。
GitHub 专用的审阅记名、gh 和自动合并流程不适用于 GitLab。

通过 orchestrator_ack 确认请求，通过 orchestrator_report 报告结果。
最终消息由主 Session 经 Outbox 回到原 Issue/MR，避免直接使用 CLI 重复发送。
遇到 401、403 或 404 权限错误时，报告受阻，不切换身份或扩大权限。
