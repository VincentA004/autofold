import {expect, test} from 'bun:test'
import {createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent} from '@earendil-works/pi-ai'
import {MemorySessionStore, PiRuntime, DEFAULT_MODEL} from './index'

function message(thinking: string): AssistantMessage {
  return {role: 'assistant', api: DEFAULT_MODEL.api, provider: DEFAULT_MODEL.provider, model: DEFAULT_MODEL.id,
    content: [{type: 'thinking', thinking}], timestamp: Date.now(), stopReason: 'stop',
    usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}}
}

test('large repeated partial responses produce bounded progress journals while live updates and final transcript remain exact', async () => {
  const store = new MemorySessionStore()
  const thinking = 'x'.repeat(600000), chunks = 18
  let liveCharacters = 0
  const runtime = new PiRuntime({store, streamFn: () => {
    const stream = createAssistantMessageEventStream()
    stream[Symbol.asyncIterator] = async function* () {
      yield {type: 'start', partial: message('')} as AssistantMessageEvent
      for (let index = 1; index <= chunks; index++) {
        await Bun.sleep(75)
        const partial = message(thinking.slice(0, Math.ceil(thinking.length * index / chunks)))
        yield {type: 'thinking_delta', contentIndex: 0, delta: 'x'.repeat(33334), partial} as AssistantMessageEvent
      }
      const final = message(thinking)
      stream.end(final)
      yield {type: 'done', reason: 'stop', message: final} as AssistantMessageEvent
    }
    return stream
  }})
  const session = await runtime.create()
  const result = await runtime.run(session.id, 'Preserve this complete offline reasoning fixture', {onEvent: event => {
    if (event.type === 'message_update') {
      const raw = event.data as {message: AssistantMessage}
      const block = raw.message.content[0]
      if (block?.type === 'thinking') liveCharacters = Math.max(liveCharacters, block.thinking.length)
    }
  }})
  expect(result.status).toBe('completed')
  expect(liveCharacters).toBeGreaterThan(300000)
  const events = await store.events(session.id), progress = events.filter(event => event.type === 'message_update')
  expect(progress.length).toBeGreaterThanOrEqual(4)
  for (const event of progress) {
    expect(event.data).toMatchObject({format: 'autofold.pi-progress.v1', progressOnly: true})
    expect(JSON.stringify(event).length).toBeLessThan(2000)
    expect((event.data as any).assistantMessageEvent.partial).toBeUndefined()
    expect((event.data as any).message.content).toBeUndefined()
  }
  expect(progress.reduce((sum, event) => sum + JSON.stringify(event).length, 0)).toBeLessThan(progress.length * 2000)
  const last = result.session.messages.findLast(message => message.role === 'assistant')!
  expect(last.content).toEqual([{type: 'thinking', thinking}])
  expect(events.findLast(event => event.type === 'message_end' && (event.data as any).message?.role === 'assistant')!.data).toMatchObject({message: {content: [{type: 'thinking', thinking}]}})
  expect((await store.get(session.id))!.messages).toEqual(result.session.messages)
  expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
})
