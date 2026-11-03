import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { executorTools } from '../src/app/tools/executor.ts'
import type { ResourceHost } from '../src/app/resources.ts'
import { Store } from '../src/app/store.ts'
import { settingsPolicy, SettingsSchema } from '../src/policy.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { writeGitlabCli, writeEnvironment, workerGitConfig } from '../src/infra/environment.ts'
import { testMachine } from './fixtures/deployment.ts'
import type { Deployment } from '../src/deployment.ts'
import { resolveGitlabDeployment } from '../src/sources/gitlab-deployment.ts'
import { gitlabKind, gitlabTrigger, pollGitlab } from '../src/sources/gitlab.ts'
import { MergeRequestSchema, claimMergeRequest, observeMergeRequest } from '../src/sources/gitlab-merge.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabThreadContext, readGitlabRepository } from '../src/sources/gitlab-read.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { KV } from '../src/kv.ts'

const directories: string[] = []
const stores: Store[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'superagent-gitlab-')); directories.push(path); return path }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
const deployment = (stateDir = directory()): Deployment => ({ ...testMachine({ stateDir }), repository: 'team/sub/project', gitlab: {
  cli: '/bin/false', host: 'gitlab.example.test', login: 'agent', noreply: '7-agent@users.noreply.gitlab.example.test',
  projectId: 349, defaultBranch: 'master', url: 'https://gitlab.example.test/team/sub/project',
} })
const alice = { id: 1, username: 'alice' }
const item = (overrides = {}) => ({ id: 101, iid: 1, title: '@agent fix it', description: '', author: alice,
  created_at: '2026-11-02T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z', state: 'opened', web_url: 'https://gitlab.example.test/team/sub/project/-/issues/1', ...overrides })
const note = (overrides = {}) => ({ id: 200, body: '@agent follow up', author: alice, created_at: '2026-11-02T00:00:01.000Z', system: false, ...overrides })
const mr = (overrides = {}) => MergeRequestSchema.parse({ ...item(), source_branch: 'agent/fix-it', source_project_id: 349, target_project_id: 349,
  author: { id: 7, username: 'agent' }, merged_at: null, closed_at: null, sha: 'abc', ...overrides })
function harness() {
  const deployed = deployment()
  const store = new Store(join(deployed.stateDir, 'test.sqlite')); stores.push(store)
  const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: { host: deployed.gitlab!.host, repository: deployed.repository, credential: 'stored' } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } } })
  store.saveSettings(settings)
  const sources = new SourceRegistry(() => store.settings()); sources.register(gitlabKind)
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(), release: vi.fn() }, executor: { start: vi.fn(), stop: vi.fn(), deliver: vi.fn() }, outbox,
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'fix-it', directory: join(deployed.stateDir, 'work'), assignment: '' } }) })
  const commands = new Commands(() => deployed, {}, new AbortController().signal)
  const ctx = sourceContextOf({ store, engine, outbox, commands, sources, deployment: deployed, ready: Promise.resolve(), configured: () => true,
    receive: trigger => engine.receive(trigger) }, gitlabKind)
  return { ctx, store, engine, commands, deployed }
}
function accepted(h: ReturnType<typeof harness>, iid = 1) {
  const trigger = gitlabTrigger(h.ctx, 'issue', item({ iid }))!
  h.engine.receive(trigger)
  const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: 'fix it', name: 'fix-it', reason: 'explicit request', acknowledgement: 'Working on it' })
  const ticket = h.store.tickets.get(decision.ticketId!)!
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  return ticket
}
it('separates Issue and MR IIDs, suppresses self/system messages and checks mention boundaries', () => {
  const h = harness()
  const issue = gitlabTrigger(h.ctx, 'issue', item())!, merge = gitlabTrigger(h.ctx, 'mr', item())!
  expect(issue.id).not.toBe(merge.id)
  expect(issue.threads[0]?.id).toBe('issue:1')
  expect(merge.threads[0]?.id).toBe('mr:1')
  expect(issue.addressed).toBe('mention')
  expect(gitlabTrigger(h.ctx, 'issue', item({ title: '@agent-other' }))?.addressed).toBeUndefined()
  expect(gitlabTrigger(h.ctx, 'issue', item({ author: { id: 7, username: 'agent' } }))).toBeUndefined()
  expect(gitlabTrigger(h.ctx, 'issue', item(), note({ system: true }))).toBeUndefined()
})
it('admits allowed explicit mentions while rejecting unlisted requests', () => {
  const h = harness()
  const good = gitlabTrigger(h.ctx, 'issue', item())!
  h.engine.receive(good); h.engine.evaluateDue()
  expect(h.engine.candidate(good.id)?.strength).toBe('explicit')
  const bad = gitlabTrigger(h.ctx, 'issue', item({ iid: 2, author: { id: 2, username: 'guest' } }))!
  h.engine.receive(bad); h.engine.evaluateDue()
  expect(h.engine.candidate(bad.id)).toBeUndefined()
})
it('binds the agent MR, keeps ready work awaiting review and ends it on merge', () => {
  const h = harness(), ticket = accepted(h)
  expect(claimMergeRequest(h.ctx, ticket.id, mr())).toBeUndefined()
  h.engine.report(ticket.id, { state: 'ready', summary: 'MR ready' })
  expect(h.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  observeMergeRequest(h.ctx, mr({ state: 'merged', merged_at: '2026-11-02T00:10:00Z' }))
  expect(h.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
})
it('rejects an unrelated author, fork, branch, project and duplicate MR owner', () => {
  const h = harness(), ticket = accepted(h)
  for (const changes of [{ author: alice }, { source_project_id: 99 }, { source_branch: 'main' }, { target_project_id: 99 }]) {
    expect(claimMergeRequest(h.ctx, ticket.id, mr(changes))).toBeTypeOf('string')
  }
  expect(claimMergeRequest(h.ctx, ticket.id, mr())).toBeUndefined()
  const other = accepted(h, 2)
  expect(claimMergeRequest(h.ctx, other.id, mr())).toContain('another active ticket')
})
it('uses a durable cursor and deduplicates replayed notes', async () => {
  const h = harness(); h.store.set(KV.gitlab.since, '2026-11-01T00:00:00.000Z')
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'gitlabPages').mockImplementation(async (_schema, path) => path.startsWith('issues?') ? [item()] : path.includes('/notes?') ? [note()] : [] as never)
  await pollGitlab(h.ctx)
  const trigger = gitlabTrigger(h.ctx, 'issue', item(), note())!
  expect(h.store.triggers.get(trigger.id)).toBeDefined()
  expect(h.store.threads.get('gitlab:issue:1')?.pending).toHaveLength(2)
  h.store.set(KV.gitlab.since, '2026-11-01T00:00:00.000Z')
  await pollGitlab(h.ctx)
  expect(h.store.threads.get('gitlab:issue:1')?.pending).toHaveLength(2)
})
it('does not advance the cursor on a failed round', async () => {
  const h = harness(), before = '2026-11-01T00:00:00.000Z'; h.store.set(KV.gitlab.since, before)
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'gitlabPages').mockRejectedValue(new Error('network failure'))
  await expect(pollGitlab(h.ctx)).rejects.toThrow('network failure')
  expect(h.store.get(KV.gitlab.since)).toBe(before)
})
it('sends once after a remote success followed by a local retry, preserving permission failures', async () => {
  const h = harness(), trigger = gitlabTrigger(h.ctx, 'issue', item())!
  const message = { id: 'reply1', channel: trigger.channel!, text: 'Done', kind: 'reply' as const }
  const pages = vi.spyOn(h.commands, 'gitlabPages').mockResolvedValue([])
  const send = vi.spyOn(h.commands, 'gitlab').mockResolvedValue({})
  expect(await sendGitlab(h, message)).toBe('sent')
  pages.mockResolvedValue([note({ author: { id: 7, username: 'agent' }, body: 'Done\n<!-- dsh-superagent:reply1 -->' })])
  expect(await sendGitlab(h, message)).toBe('sent'); expect(send).toHaveBeenCalledTimes(1)
  pages.mockRejectedValue(new CliError('Not found', 404))
  await expect(sendGitlab(h, message)).rejects.toThrow('Not found')
})
it('reads paged thread context and preserves system-note pagination', async () => {
  const h = harness(), trigger = gitlabTrigger(h.ctx, 'issue', item())!
  vi.spyOn(h.commands, 'gitlab').mockImplementation(async (_schema, path) => path.includes('/notes?') ? [note()] : item() as never)
  const context = await gitlabThreadContext.read(h.commands, trigger, 'thread', undefined, {})
  expect(context.messages.map(message => message.id)).toEqual(['root-issue-1', '200'])
  await expect(gitlabThreadContext.read(h.commands, trigger, 'thread', '../2', {})).rejects.toThrow()
})
it('restricts REST calls to the configured project and decodes repository files', async () => {
  const h = harness()
  const run = vi.spyOn(h.commands, 'run').mockResolvedValue(JSON.stringify({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }))
  expect(await readGitlabRepository(h.commands, 'src/file.ts', 'file')).toBe('hello')
  expect(run.mock.calls[0]?.[1]).toContain('projects/349/repository/files/src%2Ffile.ts?ref=master')
  for (const path of ['../user', '/user', 'https://elsewhere.test', 'issues/../other']) await expect(h.commands.gitlab(z.unknown(), path)).rejects.toThrow('restricted')
  await expect(readGitlabRepository(h.commands, '.env', 'file')).rejects.toThrow('non-hidden')
})
it('keeps stored glab identity independent of ambient tokens and emits a GitLab git configuration', async () => {
  const dir = directory(), fake = join(dir, 'fake-glab')
  writeFileSync(fake, '#!/bin/sh\n[ -z "$GITLAB_TOKEN" ] && [ -z "$GITLAB_ACCESS_TOKEN" ] && [ "$GITLAB_HOST" = gitlab.example.test ]\n', { mode: 0o700 })
  vi.stubEnv('GITLAB_PAT', 'fake-secret'); vi.stubEnv('GITLAB_TOKEN', 'wrong-identity')
  const cli = await writeGitlabCli(dir, fake, 'gitlab.example.test', 'stored')
  expect(execFileSync(cli).toString()).toBe('')
  expect(readFileSync(cli, 'utf8')).not.toContain('fake-secret')
  const deployed = deployment(dir); deployed.gitlab!.cli = cli
  await writeEnvironment(deployed, [])
  expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('https://gitlab.example.test')
  expect(readFileSync(workerGitConfig(dir), 'utf8')).not.toContain('github.com')
})
it('stores environment credentials privately without embedding them in the CLI wrapper', async () => {
  const dir = directory(); vi.stubEnv('GITLAB_PAT', 'fake-secret')
  const cli = await writeGitlabCli(dir, '/bin/false', 'gitlab.example.test', 'environment')
  expect(statSync(join(dirname(cli), 'gitlab-credential')).mode & 0o777).toBe(0o600)
  expect(readFileSync(cli, 'utf8')).not.toContain('fake-secret')
})
it('verifies GitLab identity, subgroup project and Developer access during setup', async () => {
  const machine = testMachine({ stateDir: directory() })
  const project = { id: 349, path_with_namespace: 'team/sub/project', web_url: 'https://gitlab.example.test/team/sub/project', default_branch: 'master',
    permissions: { project_access: { access_level: 30 }, group_access: null } }
  const probe = vi.fn(async (argv: string[]) => JSON.stringify(argv.at(-1) === 'user' ? { id: 7, username: 'agent' } : project))
  const config = { host: 'gitlab.example.test', repository: 'team/sub/project', cli: process.execPath, credential: 'stored' }
  const resolved = await resolveGitlabDeployment(machine, config, probe)
  expect(resolved.github).toBeUndefined(); expect(resolved.gitlab?.projectId).toBe(349)
  expect(probe.mock.calls.at(-1)?.[0].at(-1)).toBe('projects/team%2Fsub%2Fproject')
  project.permissions.project_access.access_level = 20
  await expect(resolveGitlabDeployment(machine, config, probe)).rejects.toThrow('Developer')
})

it('permits explicit self-requests only when configured and never ingests agent replies or MR roots', () => {
  const h = harness(), saved = h.store.settings()
  saved.sources.gitlab!.config.allowSelfRequests = true
  h.store.saveSettings(saved)
  const author = { id: 7, username: 'agent' }
  expect(gitlabTrigger(h.ctx, 'issue', item({ author }))?.addressed).toBe('mention')
  expect(gitlabTrigger(h.ctx, 'mr', item({ author }))).toBeUndefined()
  expect(gitlabTrigger(h.ctx, 'issue', item(), note({ author }))?.addressed).toBe('mention')
  expect(gitlabTrigger(h.ctx, 'issue', item(), note({ author, body: '@agent done <!-- dsh-superagent:reply -->' }))).toBeUndefined()
  expect(gitlabTrigger(h.ctx, 'issue', item(), note({ author, body: 'thanks' }))).toBeUndefined()
})

it('keeps a running credential wrapper unchanged when another credential is checked', async () => {
  const dir = directory(); vi.stubEnv('GITLAB_PAT', 'first-fake-token')
  const first = await writeGitlabCli(dir, '/bin/false', 'gitlab.example.test', 'environment')
  vi.stubEnv('GITLAB_PAT', 'second-fake-token')
  const second = await writeGitlabCli(dir, '/bin/false', 'gitlab.example.test', 'environment')
  expect(first).not.toBe(second)
  expect(readFileSync(join(dirname(first), 'gitlab-credential'), 'utf8')).toContain('first-fake-token')
  expect(readFileSync(join(dirname(second), 'gitlab-credential'), 'utf8')).toContain('second-fake-token')
})

it('routes the executor mr_iid report through GitLab binding before recording ready', async () => {
  const h = harness(), ticket = accepted(h)
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'gitlab').mockResolvedValue(mr())
  const tools = executorTools({ engine: h.engine, store: h.store, github: h.ctx, gitlab: h.ctx,
    sessions: { relay: vi.fn(), notify: vi.fn() }, resources: {} as ResourceHost, sendReplies: async () => {} }, ticket)
  const report = tools.find(tool => tool.name === 'orchestrator_report')!
  await report.execute(report.schema.parse({ state: 'ready', summary: 'MR ready', mr_iid: 1 }), new AbortController().signal)
  expect(h.store.tickets.get(ticket.id)?.follows?.some(follow => follow.thread === 'gitlab:mr:1')).toBe(true)
  expect(h.store.tickets.get(ticket.id)?.ended).toBeUndefined()
})
