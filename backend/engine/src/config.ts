import fs from 'node:fs/promises'
import z from 'zod'
import path from 'node:path'
import type { ScientificExecutionOptions } from './execution'
import { RemoteProfile, RemoteWorkerTransport } from './execution/remote'

const AbsolutePath = z.string().refine(path.isAbsolute, 'Execution paths must be absolute')
const ExecutionConfig = z.object({
  remote: RemoteProfile.optional(),
  python: AbsolutePath.optional(),
  workerRoot: AbsolutePath.optional(),
  evidenceExecution: z.enum(["legacy_dag_v1", "native_tool_sequence_v1"]).optional(),
  proto: z.object({ root: AbsolutePath, python: AbsolutePath, languageCommit: z.string().regex(/^[a-f0-9]{40}$/), toolsCommit: z.string().regex(/^[a-f0-9]{40}$/) }).strict().optional(),
  authorization: z.object({
    deadlineMs: z.number().int().positive().safe().optional(),
    localProto: z.boolean().optional(), remote: z.boolean().optional(), maximumGpuSeconds: z.number().finite().nonnegative(),
    maximumCandidates: z.number().int().positive(), maximumWallTimeMinutes: z.number().int().positive(),
  }).strict(),
}).strict()

/** Only a host-selected file supplies execution grants, never a model or HTTP body. */
export async function loadExecutionConfig(file?: string): Promise<Omit<ScientificExecutionOptions, 'workspace' | 'projectId' | 'research'> | undefined> {
  if (!file) return undefined
  const { remote, ...execution } = ExecutionConfig.parse(JSON.parse(await fs.readFile(path.resolve(file), 'utf8')))
  if (remote && !execution.authorization.remote) throw new Error('SSH execution requires explicit host remote authorization')
  if(!remote)return execution
  const transport=new RemoteWorkerTransport({profile:remote,workerRoot:execution.workerRoot??path.resolve(import.meta.dir,'../../worker')})
  if(Boolean(remote.inspectionBubblewrap)!==Boolean(remote.inspectionBubblewrapSha256))throw new Error('Remote inspection requires both executable and exact identity')
  return {...execution,transport,...(remote.inspectionBubblewrap?{inspectionBoundary:{containmentName:'remote_linux_bubblewrap',execute:transport.inspect.bind(transport)}}:{})}

}
