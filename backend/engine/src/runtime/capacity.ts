import type {Api, Model} from '@earendil-works/pi-ai'

/** Host rejection at the supported built-in provider payload boundary, before
 * HTTP dispatch. Throw only when the host can prove no provider request began.
 * Errors from transports or custom stream functions do not establish that proof. */
export class PiLocalPayloadAdmissionRejected extends Error {
  constructor(message: string) {super(message); this.name = 'PiLocalPayloadAdmissionRejected'}
}

/** A local admission failure, before Pi invokes the HTTP transport. This is not
 * a provider zero-cost receipt. Pi recognizes the context error and owns recovery. */
export class PiLocalContextOverflow extends Error {
  constructor(window: number, input: number) {
    super(`maximum context length is ${window} tokens: prepared prompt byte bound ${input} leaves no output capacity; compact context before dispatch`)
    this.name = 'PiLocalContextOverflow'
  }
}

/** Pi's supported payload hook runs after provider conversion. Count the actual
 * messages, system instructions, tool schemas and response schema, not a stale
 * usage sample. One token per serialized UTF-8 byte is deliberately conservative
 * for byte-level tokenizers; framing has additional room. This is a capacity
 * bound, not an exact tokenizer count or a fixed response-length ceiling.
 * Never include HTTP credentials/headers or persist prompt content here. */
export function fitPiPayloadToContext(payload: unknown, model: Model<Api>) {
  if (model.api !== 'openai-completions') return undefined
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Pi prepared payload must be an object')
  const request = payload as Record<string, unknown>
  if (!Array.isArray(request.messages)) throw new Error('Pi prepared chat payload has no messages')
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) throw new Error('Pi payload requires a valid model context window')
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new Error('Pi payload requires a valid model output maximum')
  const prompt = {messages: request.messages, tools: request.tools, response_format: request.response_format, tool_choice: request.tool_choice}
  const promptBytes = Buffer.byteLength(JSON.stringify(prompt), 'utf8')
  const framingTokens = 4096 + 32 * request.messages.length
  const inputTokenBound = promptBytes + framingTokens
  const availableOutputTokens = model.contextWindow - inputTokenBound
  if (availableOutputTokens < 1) throw new PiLocalContextOverflow(model.contextWindow, inputTokenBound)
  const fields = ['max_tokens', 'max_completion_tokens'].filter(key => request[key] !== undefined)
  if (!fields.length) throw new Error('Pi prepared payload has no native output reservation')
  const fitted = {...request}
  for (const field of fields) {
    const desired = request[field]
    if (typeof desired !== 'number' || !Number.isSafeInteger(desired) || desired < 1) throw new Error('Pi prepared output reservation is invalid')
    fitted[field] = Math.min(desired, model.maxTokens, availableOutputTokens)
  }
  return {payload: fitted, sizing: {format: 'autofold.pi-prepared-capacity.v1', promptBytes, framingTokens,
    inputTokenBound, contextWindow: model.contextWindow, modelOutputMaximum: model.maxTokens,
    nativeRequestedOutputTokens: Math.min(...fields.map(key => request[key] as number)),
    admittedOutputTokens: Math.min(...fields.map(key => fitted[key] as number)), arbitraryOutputCap: null}}
}
