# GitLab CE 15.9 试点

当前支持单个 GitLab 项目，保留 GitHub 部署能力。一个部署只选择一个代码托管来源。

## 已实现的范围

- 白名单用户在 Issue、MR 或评论中 @ 代理，进入明确请求流程。
- 订阅中的追问、手动停止与恢复沿用核心授权模型。
- Issue 与 MR 的线程分别为 `gitlab:issue:<iid>`、`gitlab:mr:<iid>`。
- 普通评论上下文、分页与回复；出站消息使用隐藏标记防止重试重复发送。
- 代理工单分支的 MR 绑定、合并或关闭后的工单状态更新。
- 仓库文件和目录读取，使用 GitLab REST v4。
- 新建独立缓存和工单 worktree，保留原仓库工作目录。

首轮使用轮询。游标从首次启动时刻开始，不接历史请求。轮询读取发生更新的 Issue/MR，并持续读取已订阅讨论。接入不包含 Pipeline 事件、行级 Discussion 定位回复或自动合并。

## yushu 配置

[示例配置](../examples/gitlab-yushu.json) 指定：

- 主机：`gitlab.daikuan.qihoo.net`。
- 项目：`360shuke/yushu`，项目 ID 由 API 解析。
- 本地仓库：`/Users/xiexiaodong/workspace/code/gitlab/yushu`。
- 凭证：`glab` 已保存身份，白名单 `xiexiaodong-jk`。

先构建，再初始化一个新的状态目录：

```sh
pnpm --pm-on-fail=ignore install --frozen-lockfile
pnpm --pm-on-fail=ignore check
node --experimental-transform-types scripts/configure-gitlab.ts \
  examples/gitlab-yushu.json "$PWD/.artifacts/gitlab-yushu"
```

初始化会只读验证账号、项目和 Developer 以上权限。已有状态目录不会被覆盖。默认暂停、`observe` 模式、一个并发执行器、没有主动接单规则。明确请求在解除暂停后仍可执行。

GitLab 账号提交邮箱使用实例 noreply 形式作为默认值。仓库若要求指定作者或校验邮箱，应在团队提示词中设置明确身份。

## 启动 DSH

按 [部署说明](006-deployment.md) 安装兼容的 DSH，并在新的 `superagent-gitlab` profile 中配置模型。仅首次创建 profile 时运行：

```sh
dsh superagent-gitlab --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent-gitlab add "link:$PWD"
```

将状态目录下生成的 `profile.cordis.patch.yml` 作为该 profile 的 `cordis.patch.yml`。端口默认 3082；若有其他实例占用，请修改端口。禁止用 profile 创建命令覆盖已有 profile。

```sh
scripts/dsh-superagent --profile superagent-gitlab start
scripts/dsh-superagent --profile superagent-gitlab status
```

进入管理面板，确认来源、身份、模型和执行目录，再解除暂停。白名单用户在试点 Issue 中发送 `@xiexiaodong-jk <明确任务>`。该身份也用于代理，示例明确开启 `allowSelfRequests`，只允许账号通过 @ 自己发起请求；带代理隐藏标记的消息和代理创建的 MR 正文仍被过滤。普通未 @ 的自身追问不会投递，需要再次 @。独立代理账号部署应关闭此选项。

执行器通过 `orchestrator_report` 的 `mr_iid` 绑定 MR，不能使用 `pr_number`。试点由人审批和合并 MR。

## 认证与凭证文件

`credential=stored` 使用 `glab` 已保存的身份。包装器清除环境中的 Token 覆盖，并固定 GitLab 主机。保存的登录配置必须在运行 DSH 的系统账户下可用。

`credential=environment` 从服务启动环境的 `GITLAB_PAT` 建立凭证。DSH 会清理带 Token 名称的环境变量，因此状态目录的 `gitlab-auth/<身份摘要>/` 中使用权限为 0600 的 `gitlab-credential` 文件，由包装器在执行 glab 时读取。该文件包含凭证，不要提交或分享整个状态目录。环境 Token 方式要求每次启动都提供 GITLAB_PAT。更换认证配置生成独立包装器，避免失败的账号检查影响运行中的身份。

管理面板、提示词、API 参数和日志不包含 Token。包装器只约束默认调用方式，不是 OS 隔离；请使用专用账户或隔离运行环境。

## 验收

先验证明确请求、未授权拒绝、重复事件和回复去重，再验证生成 MR、人工合并、停止与重启恢复。未完成真实 MR 链路前，不宣称试点端到端可用。

当前账号具备权限并不代表它是合适的长期代理身份。建议给代理单独配置 GitLab 账号，保留人的账号用于提交请求和审阅。


## 本机独立运行入口

本次安装的 DSH 位于项目 `.artifacts/dsh-runtime`，数据位于 `.artifacts/dsh-home`。`superagent-gitlab` profile 已挂载当前项目。启停脚本会设置这两个路径：

```sh
scripts/gitlab-pilot status
scripts/gitlab-pilot stop
scripts/gitlab-pilot start
```

管理面板地址为 `http://127.0.0.1:3082`。首次访问必须使用当前服务启动日志中 `dsh web:` 后的完整认证 URL；只打开端口地址会显示 authentication required。认证成功后，浏览器保存 Cookie 并跳转到普通地址。不同浏览器需要分别认证；重启后若认证失效，请使用新启动日志中的入口。不要分享认证 URL。

启动日志位于项目 `.artifacts/dsh-superagent-superagent-gitlab-*.log`，选取当前启动生成的最新文件。登录后进入侧栏 Superagent 查看试点。

2026-11-02 已验证 runtime 与 GitLab 轮询均为 ready。评估与执行器均配置为 minimax-pilot / MiniMax-M3，复用已确认的 Claude Code 模型服务。普通调用返回 MODEL_OK，shell 工具调用返回 TOOL_OK。处理保持暂停，尚未进行真实 Issue 到 MR 的验收。

模型凭据保存在独立 DSH_HOME 下的 .credentials.yaml，权限为 0600。profile 仅保存凭据引用。不要分享或提交该凭据文件。


## 当前使用桌面客户端

试点已迁移到 `/Applications/DeepSeek Harness.app`，桌面版本为 0.2.1-rc.5。客户端启动时加载 desktop profile 和本地 Superagent bundle。

在客户端左侧选择 **Superagent**，查看 GitLab 来源、执行状态和工单。若窗口仍显示安装前的界面，重载窗口后查看。

当前仍保持暂停。评估和执行器使用 MiniMax-M3，个人客户端的原有默认模型和其他 provider 保留。

独立 Web 实例已停止；不要再运行 `scripts/gitlab-pilot start` 与客户端同时使用同一状态目录。客户端退出后，试点也随其后端停止。

桌面配置备份在项目 `.artifacts/desktop-migration-backup`，其中包含私有凭据备份，不要分享或提交。验证结果见 `.artifacts/gitlab-yushu/validation/desktop-status.json`。

当前桌面后端动态选择本机端口，使用客户端即可，无需访问旧的 3082 地址。
