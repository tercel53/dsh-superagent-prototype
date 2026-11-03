/** GitLab CE 15.9 Source: explicit Issue/MR requests, comments, and bound MR lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountsSchema } from '../deployment.ts'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sameName } from '../infra/text.ts'
import { sourceContext, health, type SourceContext } from './host.ts'
import type { SourceKind, Localized } from './kind.ts'
import { pause, cursorAt, polled } from './poll.ts'
import { GitlabAddressSchema, GitlabItemSchema, GitlabNoteSchema, gitlabThreadContext, collection, gitlabThread, gitlabItemPath, type GitlabKind, type GitlabItem } from './gitlab-read.ts'
import { MergeRequestSchema, observeMergeRequest } from './gitlab-merge.ts'
import { sendGitlab } from './gitlab-channel.ts'

export const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(30).max(3600).default(60), allowSelfRequests: z.boolean().default(false) }).strict()
type Config = z.infer<typeof GitlabConfigSchema>
const accountRows = [{ key: 'id', type: 'text' as const, label: { zh: '用户名', en: 'Username' } }]
export const gitlabKind: SourceKind<Config> = {
  kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '接收 GitLab 项目中的明确请求与已订阅讨论，跟踪 MR 合并和关闭。', en: 'Explicit requests and subscribed conversations in one GitLab project, with MR lifecycle tracking.' },
  schema: GitlabConfigSchema, health: ['gitlab'],
  fields: [
    { key: 'host', type: 'text', label: { zh: 'GitLab 主机', en: 'GitLab host' } },
    { key: 'repository', type: 'text', label: { zh: '项目路径（支持子组）', en: 'Project path including subgroups' } },
    { key: 'cli', type: 'text', label: { zh: 'glab 命令或绝对路径', en: 'glab command or absolute path' } },
    { key: 'credential', type: 'select', label: { zh: '认证方式', en: 'Credentials' }, options: [
      { value: 'environment', label: { zh: '启动环境 GITLAB_PAT', en: 'GITLAB_PAT at startup' } },
      { value: 'stored', label: { zh: 'glab 已保存身份', en: 'Saved glab identity' } }] },
    { key: 'allowSelfRequests', type: 'switch', label: { zh: '允许个人账号 @ 自己发起请求', en: 'Allow explicit self-mentions' }, hint: { zh: '仅用于人和代理共用账号的试点；带代理标记的回复和代理创建的 MR 不进入请求。', en: 'For a shared human/agent identity in a pilot; agent-marked replies and agent MR roots are excluded.' } },
    { key: 'pollSeconds', type: 'number', min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / seconds' } },
  ],
  scope: () => ({ listened: true, observed: false }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().min(1) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 用户', en: 'GitLab users who may request work' }, columns: accountRows },
      { key: 'bots', type: 'rows', label: { zh: '允许评估的机器人', en: 'Bots eligible for assessment' }, columns: accountRows }],
    explicit: { zh: '白名单用户在 Issue、MR 或评论中 @ 代理账号。', en: 'An allowed user mentions the agent in an Issue, MR or comment.' },
  },
  channel: { send: sendGitlab, link: (address, links) => {
    const { kind, iid } = GitlabAddressSchema.parse(address)
    return { url: address.url ?? `${links.gitlab?.url ?? ''}/-/${collection(kind)}/${iid}`,
      label: { zh: `GitLab ${kind === 'mr' ? 'MR' : 'Issue'} ${iid}`, en: `GitLab ${kind === 'mr' ? 'MR' : 'Issue'} ${iid}` } }
  } },
  threadContext: gitlabThreadContext,
  find: query => {
    const matched = /(?:^|\s)([!#])(\d+)\b/.exec(query.trim())
    return { threads: matched ? [gitlabThread(matched[1] === '!' ? 'mr' : 'issue', Number(matched[2]))] : [], terms: [] }
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 主机', en: 'GitLab host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: 'GitLab 项目路径', en: 'GitLab project path' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT_ID', description: { zh: 'GitLab 项目 ID', en: 'GitLab project ID' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: 'glab 使用的代理用户名', en: 'Agent username used by glab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '代理默认提交邮箱', en: 'Agent default commit email' } },
      { key: 'DSH_SUPERAGENT_GITLAB_BRANCH', description: { zh: '项目默认分支', en: 'Project default branch' } },
    ],
    values: ({ deployment }): Record<string, string> => deployment.gitlab ? {
      DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab.host, DSH_SUPERAGENT_GITLAB_PROJECT: deployment.repository,
      DSH_SUPERAGENT_GITLAB_PROJECT_ID: String(deployment.gitlab.projectId), DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab.login,
      DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab.noreply, DSH_SUPERAGENT_GITLAB_BRANCH: deployment.gitlab.defaultBranch,
    } : {},
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? { cli: `@${deployment.gitlab.login}` } : {},
}
// Keep Issue and MR IDs separate: their project-local IIDs can be equal.
export function gitlabTrigger(ctx: SourceContext, kind: GitlabKind, item: GitlabItem, note?: z.infer<typeof GitlabNoteSchema>): Trigger | undefined {
  const agent = ctx.deployment.gitlab!
  const author = note?.author ?? item.author
  if (note?.system) return undefined
  const text = note?.body ?? `${item.title}\n\n${item.description ?? ''}`
  const addressed = new RegExp(`(^|[^A-Za-z0-9_.-])@${agent.login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])`, 'i').test(text)
  if (sameName(author.username, agent.login)) {
    const self = ctx.config<Config>('gitlab')?.allowSelfRequests
    if (!self || !addressed || text.includes('<!-- dsh-superagent:') || (!note && kind === 'mr')) return undefined
  }
  const thread = `${kind}:${item.iid}`
  return { id: key('gitlab', String(agent.projectId), kind, String(item.iid), note ? `note-${note.id}` : 'root'), source: 'gitlab',
    threads: [{ source: 'gitlab', id: thread }], actor: { source: 'gitlab', id: author.username }, human: !author.bot,
    addressed: addressed ? 'mention' : undefined, at: note?.created_at ?? item.created_at, text,
    channel: { source: 'gitlab', thread, address: { kind, iid: String(item.iid), url: item.web_url } },
    meta: { kind, iid: item.iid, ...(note ? { noteId: note.id } : {}) }, url: note ? `${item.web_url}#note_${note.id}` : item.web_url }
}
export async function pollGitlab(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const started = new Date().toISOString()
  const since = ctx.state.get(KV.gitlab.since) ?? started
  // Persist the first start before reading so a failed first round does not move the observation boundary.
  if (!ctx.state.get(KV.gitlab.since)) ctx.state.set(KV.gitlab.since, since)
  for (const kind of ['issue', 'mr'] as const) {
    const items = await commands.gitlabPages(GitlabItemSchema, `${collection(kind)}?scope=all&state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc`)
    const refs = new Map(items.map(item => [item.iid, item]))
    for (const thread of ctx.threads.subscribed('gitlab')) {
      if (!polled(ctx, thread)) continue
      const match = new RegExp(`^gitlab:${kind}:(\\d+)$`).exec(thread.key)
      if (match && !refs.has(Number(match[1]))) {
        const iid = Number(match[1]); refs.set(iid, await commands.gitlab(GitlabItemSchema, gitlabItemPath(kind, iid)))
      }
    }
    for (const item of refs.values()) {
      signal?.throwIfAborted()
      if (item.created_at >= since) {
        const trigger = gitlabTrigger(ctx, kind, item)
        if (trigger) await ctx.receive(trigger)
      }
      const notes = await commands.gitlabPages(GitlabNoteSchema, `${gitlabItemPath(kind, item.iid)}/notes?sort=desc&order_by=created_at`)
      for (const note of notes.filter(note => note.created_at >= since).reverse()) {
        const trigger = gitlabTrigger(ctx, kind, item, note)
        if (trigger) await ctx.receive(trigger)
      }
      ctx.threads.describe(gitlabThread(kind, item.iid), { label: item.title, url: item.web_url })
      ctx.threads.patch(gitlabThread(kind, item.iid), { kind, iid: item.iid, url: item.web_url })
      if (kind === 'mr') observeMergeRequest(ctx, await commands.gitlab(MergeRequestSchema, `merge_requests/${item.iid}`))
    }
  }
  signal?.throwIfAborted()
  ctx.state.set(KV.gitlab.since, cursorAt(started))
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch(error => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<Config>('gitlab')
    try {
      if (config && ctx.deployment.gitlab) {
        await pollGitlab(ctx, signal)
        ctx.report('gitlab', { state: 'ready', detail: 'GitLab polling is current', at: new Date().toISOString() })
      } else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      if (++failures >= 3 && !signal.aborted) ctx.report('gitlab', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
    }
    await pause((config?.pollSeconds ?? 60) * 1000, signal)
  }
}
