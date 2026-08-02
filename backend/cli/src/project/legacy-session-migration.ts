import z from "zod"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { work } from "../util/queue"
import type { SessionFilesystem } from "../session/filesystem"
import type { SessionWorkspace } from "../session/workspace"

type LegacySession = {
  id: string
  projectID: string
  directory?: string
  [key: string]: unknown
}

/**
 * Compatibility-only migration for session state written before opaque project IDs.
 * Keep this module behind a dynamic import from Project so core project identity does
 * not acquire the Session runtime (and its agent/provider dependency graph).
 */
export namespace LegacySessionMigration {
  const log = Log.create({ service: "project" })

  export async function moveSessions(
    fromBucket: string,
    newProjectID: string,
    keep: (session: LegacySession) => boolean,
  ) {
    const sessions = await Storage.list(["session", fromBucket]).catch(() => [])
    if (sessions.length === 0) return

    log.info("migrating sessions", { from: fromBucket, to: newProjectID, count: sessions.length })

    await work(10, sessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<LegacySession>(key)
      if (!keep(session)) return
      const existing = await Storage.read<LegacySession>(["session", newProjectID, sessionID]).catch((error) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      })
      if (!existing) {
        await Storage.write(["session", newProjectID, sessionID], {
          ...session,
          projectID: newProjectID,
        })
      }
      await moveFilesystem(fromBucket, newProjectID, sessionID)
      await moveWorkspace(fromBucket, newProjectID, sessionID)
      await moveKernels(fromBucket, newProjectID, sessionID)
      await Storage.remove(key)
    })
  }

  async function moveKernels(fromBucket: string, newProjectID: string, sessionID: string) {
    const paths = await Storage.list(["kernel_registry", fromBucket, sessionID]).catch(() => [])
    await work(10, paths, async (source) => {
      const raw = await Storage.read<unknown>(source)
      const parsed = z
        .object({
          identity: z.object({
            projectID: z.string(),
            sessionID: z.string(),
            name: z.string(),
            language: z.string(),
          }),
        })
        .passthrough()
        .safeParse(raw)
      if (!parsed.success) return
      const identity = {
        ...parsed.data.identity,
        projectID: newProjectID,
        sessionID,
      }
      const id = `kernel-${Bun.hash(
        `${identity.projectID}\0${identity.sessionID}\0${identity.name}\0${identity.language}`,
      ).toString(36)}`
      const target = ["kernel_registry", newProjectID, sessionID, id]
      const existing = await Storage.read<unknown>(target).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
      if (!existing) {
        await Storage.write(target, {
          ...parsed.data,
          identity,
        })
      }
      await Storage.remove(source)
    })
  }

  async function moveWorkspace(fromBucket: string, newProjectID: string, sessionID: string) {
    const source = ["session_workspace", fromBucket, sessionID]
    const workspace = await Storage.read<SessionWorkspace.Info>(source).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (!workspace) return

    const target = ["session_workspace", newProjectID, sessionID]
    const existing = await Storage.read<SessionWorkspace.Info>(target).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (!existing) {
      await Storage.write<SessionWorkspace.Info>(target, {
        ...workspace,
        projectID: newProjectID,
      })
    }
    await Storage.remove(source)
  }

  async function moveFilesystem(fromBucket: string, newProjectID: string, sessionID: string) {
    const source = ["session_filesystem", fromBucket, sessionID]
    const legacy = await Storage.read<SessionFilesystem.State>(source).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (!legacy) return

    const target = ["session_filesystem", newProjectID, sessionID]
    const existing = await Storage.read<SessionFilesystem.State>(target).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    const grants = existing
      ? [
          ...existing.grants,
          ...legacy.grants.filter((grant) => !existing.grants.some((current) => current.id === grant.id)),
        ]
      : legacy.grants
    const changed = !!existing && grants.length !== existing.grants.length
    await Storage.write<SessionFilesystem.State>(target, {
      ...(existing ?? legacy),
      sessionID,
      projectID: newProjectID,
      grants,
      revision: existing ? Math.max(existing.revision, legacy.revision) + (changed ? 1 : 0) : legacy.revision,
    })
    await Storage.remove(source)
  }

  export async function moveFilesystemBucket(
    fromBucket: string,
    newProjectID: string,
    keep: (state: SessionFilesystem.State) => boolean,
  ) {
    const records = await Storage.list(["session_filesystem", fromBucket]).catch(() => [])
    await work(10, records, async (key) => {
      const state = await Storage.read<SessionFilesystem.State>(key)
      if (!keep(state)) return
      const session = await Storage.read<LegacySession>(["session", newProjectID, state.sessionID]).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
      if (!session) return
      await moveFilesystem(fromBucket, newProjectID, state.sessionID)
    })
  }
}
