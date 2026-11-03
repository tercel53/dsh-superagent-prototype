/** GitLab CE 15.9 Issue/MR and repository reads, using REST v4 only. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { ThreadContext } from './kind.ts'
import { GitlabUserSchema } from './gitlab-deployment.ts'

export const GitlabItemSchema = z.looseObject({ id: z.number().int().positive(), iid: z.number().int().positive(), title: z.string(),
  description: z.string().nullable(), author: GitlabUserSchema, created_at: z.string(), updated_at: z.string(), state: z.string(), web_url: z.string(),
})
export const GitlabNoteSchema = z.object({ id: z.number().int().positive(), body: z.string(), author: GitlabUserSchema,
  created_at: z.string(), system: z.boolean() })
export type GitlabItem = z.infer<typeof GitlabItemSchema>
export type GitlabKind = 'issue' | 'mr'
export const collection = (kind: GitlabKind): string => kind === 'mr' ? 'merge_requests' : 'issues'
export const GitlabAddressSchema = z.object({ kind: z.enum(['issue', 'mr']), iid: z.coerce.number().int().positive() })
export const gitlabItemPath = (kind: GitlabKind, iid: number): string => `${collection(kind)}/${iid}`
export const gitlabThread = (kind: GitlabKind, iid: number): string => `gitlab:${kind}:${iid}`

export const gitlabThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.noteId ?? `root-${trigger.meta.kind}-${trigger.meta.iid}`),
  async read(commands, trigger, part, cursor) {
    const { kind, iid } = GitlabAddressSchema.parse(trigger.meta)
    const path = gitlabItemPath(kind, iid)
    const item = await commands.gitlab(GitlabItemSchema, path)
    const root = { id: `root-${kind}-${iid}`, from: item.author.username, at: item.created_at,
      text: `${item.title}\n\n${item.description ?? ''}`, url: item.web_url }
    if (part !== 'thread') return { messages: [root], body: root }
    const page = cursor === undefined ? 1 : z.coerce.number().int().positive().parse(cursor)
    const notes = await commands.gitlab(z.array(GitlabNoteSchema), `${path}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`)
    const messages = [...page === 1 ? [root] : [], ...notes.filter(note => !note.system).map(note => ({ id: String(note.id),
      from: note.author.username, at: note.created_at, text: note.body, url: `${item.web_url}#note_${note.id}`, ...note.author.bot ? { bot: true as const } : {} }))]
    return { messages, body: { title: item.title, state: item.state, url: item.web_url, messages },
      ...notes.length === 100 ? { next: String(page + 1) } : {} }
  },
}

export async function readGitlabRepository(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const ref = commands.deployment.gitlab!.defaultBranch
  const clean = parts.join('/')
  if (kind === 'file') {
    const file = await commands.gitlab(z.object({ content: z.string(), encoding: z.literal('base64') }),
      `repository/files/${encodeURIComponent(clean)}?ref=${encodeURIComponent(ref)}`)
    return Buffer.from(file.content, 'base64').toString('utf8')
  }
  const entries = await commands.gitlabPages(z.object({ name: z.string() }), `repository/tree?path=${encodeURIComponent(clean)}&ref=${encodeURIComponent(ref)}`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Model-facing read resources, with bounded note pages. */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/notes\/([1-9]\d*))?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid> or gitlab/merge_requests/<iid>, optionally /notes/<page>')
  const path = `${match[1]}/${match[2]}`
  return match[3] ? commands.gitlab(z.array(GitlabNoteSchema), `${path}/notes?per_page=100&page=${match[3]}&sort=asc&order_by=created_at`)
    : commands.gitlab(GitlabItemSchema, path)
}
