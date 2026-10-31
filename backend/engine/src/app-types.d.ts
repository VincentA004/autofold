import type { ArchiveMessage } from './archive-types'
export interface AppModel { provider: string; id: string; name: string }
export interface AppStatus {
  revision: number; enabled: boolean; connected: boolean; running: boolean; sessionId?: string; sessionPath?: string
  model?: AppModel; thinking?: string; thinkingLevels: string[]; streamText: string; tool?: string; error?: string
}
export type AppEvent = { type: 'state'; state: AppStatus } | { type: 'delta'; text: string; revision: number } | { type: 'archive_changed' }
export interface AppConversation { id: string; path: string; title: string; messages: ArchiveMessage[] }
