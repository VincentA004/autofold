import type {AssistantMessage} from '@earendil-works/pi-ai'
import type {AgentEvent} from '@earendil-works/pi-agent-core'

/** Journal progress only. Final messages and tool boundaries remain exact;
 * live observers receive the original Pi event, independently of this record. */
export function boundedProgressEvent(value: unknown) {
  const event = value as Extract<AgentEvent, {type: 'message_update'}>
  const message = event.message as AssistantMessage, update = event.assistantMessageEvent
  let textCharacters = 0, thinkingCharacters = 0, toolCalls = 0
  for (const part of message.content) {
    if (part.type === 'text') textCharacters += part.text.length
    else if (part.type === 'thinking') thinkingCharacters += part.thinking.length
    else if (part.type === 'toolCall') toolCalls++
  }
  const delta = 'delta' in update && typeof update.delta === 'string' ? update.delta : undefined
  return {format: 'autofold.pi-progress.v1', type: 'message_update', progressOnly: true,
    authority: 'Non-authoritative streaming progress. Exact completed output and tool intent are in message_end and the session transcript.',
    message: {role: message.role, timestamp: message.timestamp, textCharacters, thinkingCharacters, toolCalls},
    assistantMessageEvent: {type: update.type, ...('contentIndex' in update ? {contentIndex: update.contentIndex} : {}),
      ...(delta === undefined ? {} : {deltaCharacters: delta.length, deltaPreview: delta.slice(0, 512), truncated: delta.length > 512})}}
}
