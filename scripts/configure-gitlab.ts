/** Initialize a new, paused GitLab pilot without changing an existing deployment or remote project. */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { lockSync } from 'proper-lockfile'
import { GitlabConfigSchema } from '../src/sources/gitlab.ts'
import { resolveGitlabDeployment } from '../src/sources/gitlab-deployment.ts'
import { Store } from '../src/app/store.ts'
import { writeEnvironment } from '../src/infra/environment.ts'

const [configFile, stateDirectory] = process.argv.slice(2)
if (!configFile || !stateDirectory) throw new Error('Usage: node --experimental-transform-types scripts/configure-gitlab.ts <config.json> <absolute-state-dir>')
if (!isAbsolute(stateDirectory)) throw new Error('State directory must be absolute')
const Config = GitlabConfigSchema.extend({ repositoryPath: z.string().refine(isAbsolute, 'Use an absolute repository path'),
  allowed: z.array(z.string().min(1)).min(1) }).strict()
const { repositoryPath, allowed, ...source } = Config.parse(JSON.parse(readFileSync(resolve(configFile), 'utf8')))
const exec = promisify(execFile)
await exec('git', ['-C', repositoryPath, 'rev-parse', '--git-common-dir'])
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
const release = lockSync(stateDirectory)
let store: Store | undefined
try {
  const db = join(stateDirectory, 'orchestrator.sqlite')
  if (existsSync(db)) throw new Error('State already exists; edit this deployment through the management panel')
  const reference = (value: number) => ({ get: () => value as never })
  const machine = { stateDir: stateDirectory, projectSkillDirs: [join(repositoryPath, '.agents/skills')], promptMaxChars: reference(100000), admissionContextMaxPages: reference(10), admissionContextTimeoutMs: reference(15000) }
  const deployment = await resolveGitlabDeployment(machine, source, async argv => (await exec(argv[0]!, argv.slice(1), { maxBuffer: 1 << 20 })).stdout)
  await writeEnvironment(deployment, [])
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  const mirror = join(stateDirectory, 'repository.git')
  const remote = `https://${source.host}/${deployment.repository}.git`
  // A private bare cache supplies worktrees; the user's checkout and uncommitted files remain untouched.
  const prepare = [
    `(test -d ${quote(mirror)} || git clone --bare --no-hardlinks ${quote(repositoryPath)} ${quote(mirror)})`,
    `git --git-dir=${quote(mirror)} remote set-url origin ${quote(remote)}`,
    `git --git-dir=${quote(mirror)} fetch --no-tags origin "refs/heads/$DSH_SUPERAGENT_GITLAB_BRANCH:refs/remotes/pilot/$DSH_SUPERAGENT_GITLAB_BRANCH"`,
    `git --git-dir=${quote(mirror)} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/remotes/pilot/$DSH_SUPERAGENT_GITLAB_BRANCH"`,
  ].join(' && ')
  store = new Store(db)
  store.saveSettings({ paused: true, sources: { github: { enabled: false, config: {} }, gitlab: { enabled: true, config: source } },
    policy: { rules: [], sources: { gitlab: { allowed: allowed.map(id => ({ id })) } } }, eval: { mode: 'observe' },
    executor: { maxWorkers: 1, prepare } })
  const profile = join(stateDirectory, 'profile.cordis.patch.yml')
  writeFileSync(profile, `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 3082\n- id: dsh-superagent\n  config:\n    stateDir: ${JSON.stringify(stateDirectory)}\n    projectSkillDirs: ${JSON.stringify(machine.projectSkillDirs)}\n- id: dsh-superagent-github\n  disabled: true\n- id: dsh-superagent-gitlab\n  disabled: false\n`, { mode: 0o600 })
  console.log(JSON.stringify({ repository: deployment.repository, account: deployment.gitlab!.login, stateDirectory, profile, paused: true }, null, 2))
} finally { store?.close(); release() }
