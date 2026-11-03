/** Validate GitLab MR ownership and bind its lifecycle to Tickets. */
import { z } from 'zod'
import { liveTicket } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { ticketBranch } from './github-pull.ts'
import type { SourceContext } from './host.ts'
import { GitlabItemSchema, gitlabThread } from './gitlab-read.ts'

export const MergeRequestSchema = GitlabItemSchema.extend({ source_branch: z.string(), source_project_id: z.number().nullable(),
  target_project_id: z.number(), merged_at: z.string().nullable(), closed_at: z.string().nullable(), sha: z.string().nullable() })
export type MergeRequest = z.infer<typeof MergeRequestSchema>
export const readMergeRequest = (ctx: SourceContext, iid: number, signal?: AbortSignal) =>
  ctx.commands.withSignal(signal).gitlab(MergeRequestSchema, `merge_requests/${iid}`)
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const account = ctx.deployment.gitlab
  if (!account) return 'GitLab is not configured'
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket has ended'
  if (mr.target_project_id !== account.projectId) return 'MR is outside the configured project'
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  const origin = trigger?.source === 'gitlab' && trigger.meta.kind === 'mr' && trigger.meta.iid === mr.iid
  const own = sameName(mr.author.username, account.login) && mr.source_project_id === account.projectId && ticketBranch(ticket, mr.source_branch)
  if (!origin && !own) return 'MR must be the source MR or an agent MR on this ticket branch in the configured project'
  const thread = gitlabThread('mr', mr.iid)
  const owner = ctx.tickets.open().find(item => item.id !== ticketId && item.follows?.some(follow => follow.thread === thread && !follow.closed))
  if (owner) return 'MR already belongs to another active ticket'
  if (mr.state !== 'opened') return 'Only an open MR can be bound'
  ctx.tickets.bindThread(ticketId, { source: 'gitlab', id: `mr:${mr.iid}` }, own)
  ctx.threads.patch(thread, { kind: 'mr', iid: mr.iid, url: mr.web_url })
  return undefined
}
export function observeMergeRequest(ctx: SourceContext, mr: MergeRequest): void {
  if (mr.state === 'merged' || mr.state === 'closed') {
    ctx.tickets.threadClosed({ source: 'gitlab', id: `mr:${mr.iid}` }, mr.state === 'merged' ? 'merged' : 'closed',
      mr.merged_at ?? mr.closed_at ?? mr.updated_at)
    return
  }
  const candidates = ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch))
  const ticket = candidates.length === 1 ? candidates[0] : undefined
  if (ticket && !(ticket.follows ?? []).some(follow => follow.thread.startsWith('gitlab:mr:') && !follow.closed && follow.thread !== gitlabThread('mr', mr.iid))) {
    claimMergeRequest(ctx, ticket.id, mr)
  }
}
