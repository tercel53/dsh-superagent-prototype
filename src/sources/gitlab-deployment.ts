/** GitLab CE repository and CLI identity verification. */
import { z } from 'zod'
import { executable, GitlabAccountsSchema, type Deployment, type Machine, type Probe } from '../deployment.ts'
import { workerBin, writeGitlabCli } from '../infra/environment.ts'
import { SetupError } from '../setup.ts'

export const GitlabUserSchema = z.object({ id: z.number().int().positive(), username: z.string().min(1), bot: z.boolean().optional() })
const ProjectSchema = z.object({ id: z.number().int().positive(), path_with_namespace: z.string(), web_url: z.url(),
  default_branch: z.string().nullable(), permissions: z.object({
    project_access: z.object({ access_level: z.number() }).nullable(), group_access: z.object({ access_level: z.number() }).nullable(),
  }) })
export async function resolveGitlabDeployment(machine: Machine, value: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const config = GitlabAccountsSchema.parse(value)
  if (!config.repository) throw new SetupError('gitlabSetup', { output: 'Set the GitLab project path.' })
  try {
    const real = executable(config.cli, path, workerBin(machine.stateDir))
    const cli = await writeGitlabCli(machine.stateDir, real, config.host, config.credential)
    const run = (endpoint: string) => probe([cli, 'api', '--hostname', config.host, endpoint])
    const user = GitlabUserSchema.parse(JSON.parse(await run('user')))
    const project = ProjectSchema.parse(JSON.parse(await run(`projects/${encodeURIComponent(config.repository)}`)))
    const access = Math.max(project.permissions.project_access?.access_level ?? 0, project.permissions.group_access?.access_level ?? 0)
    if (access < 30) throw new Error(`@${user.username} needs Developer access to ${config.repository}`)
    if (!project.default_branch) throw new Error('The GitLab project needs a default branch')
    if (new URL(project.web_url).origin !== `https://${config.host}`) throw new Error('GitLab returned a project on another host')
    return { ...machine, repository: project.path_with_namespace, gitlab: { cli, login: user.username,
      noreply: `${user.id}-${user.username}@users.noreply.${config.host.split(':')[0]}`, host: config.host,
      projectId: project.id, defaultBranch: project.default_branch, url: project.web_url } }
  } catch (error) {
    throw new SetupError('gitlabSetup', { output: error instanceof Error ? error.message : String(error) })
  }
}
