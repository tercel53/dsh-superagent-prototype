/** GitLab note delivery with retry deduplication via an embedded marker. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { GitlabAddressSchema, GitlabNoteSchema, gitlabItemPath } from './gitlab-read.ts'
export async function sendGitlab({ commands }: { commands: Commands }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { kind, iid } = GitlabAddressSchema.parse(message.channel.address)
  const account = commands.deployment.gitlab
  if (!account) throw new Error('GitLab is not configured')
  const path = `${gitlabItemPath(kind, iid)}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = await commands.gitlabPages(GitlabNoteSchema, path)
    if (!notes.some(note => sameName(note.author.username, account.login) && note.body.includes(marker))) {
      await commands.gitlab(z.unknown(), path, '--method', 'POST', '--raw-field', `body=${message.text}\n\n${marker}`)
    }
    return 'sent'
  } catch (error) {
    // 404 may mean revoked project access; preserve the receipt for operator recovery.
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
