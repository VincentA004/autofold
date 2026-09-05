import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { ResearchModel } from "@/research/model"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENSCIENCE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export function outputTokenLimit(_agentName: string): number {
    return OUTPUT_TOKEN_MAX
  }

  export function shouldCapOutput(agentName: string): boolean {
    return !agentName.startsWith("autofold-")
  }

  export function providerRoutingOptions(agentName: string, providerID: string): Record<string, unknown> {
    if (!agentName.startsWith("autofold-") || providerID !== "openrouter") return {}
    return {
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        ignore: ["phala"],
      },
    }
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const forced = forceAutofoldSelection({
      agent: input.agent.name,
      originatingAgent: input.user.agent,
      providerID: input.model.providerID,
      modelID: input.model.id,
      originatingProviderID: input.user.model.providerID,
      originatingModelID: input.user.model.modelID,
    })
    const autofold = isAutofoldInference({
      agent: input.agent.name,
      originatingAgent: input.user.agent,
      originatingProviderID: input.user.model.providerID,
      originatingModelID: input.user.model.modelID,
    })
    if (forced.providerID !== input.model.providerID || forced.modelID !== input.model.id) {
      input.model = await Provider.getModel(forced.providerID, forced.modelID)
    }
    const tier = input.small || autofold
      ? { model: undefined, options: {}, headers: {} }
      : ProviderTransform.tier(input.model, input.user.tier)
    const routed = tier.model ? await Provider.getModel(input.model.providerID, tier.model) : input.model
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(routed),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = isCodexSubscriptionModel(input.model, auth)

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
        // plan mode instructions (if enabled)
        ...(await SystemPrompt.planModeInstructions()),
        // slash-skill invocation contract
        ...SystemPrompt.slashSkillDirective(),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    if (system.length === 0) {
      system.push(...original)
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(tier.options),
      mergeDeep(input.agent.options),
      mergeDeep(providerRoutingOptions(autofold ? "autofold-originated" : input.agent.name, input.model.providerID)),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )
    const providerOptions = autofold ? forceAutofoldProviderOptions(params.options) : params.options

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens = isCodex || !shouldCapOutput(input.agent.name)
      ? undefined
      : ProviderTransform.maxOutputTokens(
          input.model.api.npm,
          providerOptions,
          input.model.limit.output,
          outputTokenLimit(input.agent.name),
        )

    const tools = await modelTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, providerOptions),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("synsci")
          ? {
              "x-openscience-project": Instance.project.id,
              "x-openscience-session": input.sessionID,
              "x-openscience-request": input.user.id,
              "x-openscience-client": Flag.OPENSCIENCE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `openscience/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...tier.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...(isCodex
          ? [
              {
                role: "user",
                content: system.join("\n\n"),
              } as ModelMessage,
            ]
          : system.map(
              (x): ModelMessage => ({
                role: "system",
                content: x,
              }),
            )),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              // Apply for both stream and generate: message normalization does
              // caching, image-mime correction, unsupported-part downgrade, and
              // the providerOptions remap. Gating on "stream" only meant any
              // non-stream call (structured output, a provider that internally
              // does doGenerate) would bypass all of it and could crash on an
              // unsupported file part.
              if (args.type === "stream" || args.type === "generate") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  export function forceAutofoldSelection(input: {
    agent: string
    originatingAgent: string
    providerID: string
    modelID: string
    originatingProviderID?: string
    originatingModelID?: string
  }): ResearchModel.Selection {
    if (!isAutofoldInference(input)) {
      return { providerID: input.providerID, modelID: input.modelID }
    }
    return ResearchModel.forceResearchModel({ providerID: input.providerID, modelID: input.modelID })
  }

  /** Prevent model/agent configuration or chat hooks from adding OpenRouter
   * cross-model fallbacks while retaining same-model provider-host fallbacks. */
  export function forceAutofoldProviderOptions(options: Record<string, any>): Record<string, any> {
    const { model: _model, models: _models, fallbacks: _fallbacks, reasoning: _reasoning, ...safe } = options
    return {
      ...safe,
      // GLM 5.3 Flash rejects requests which explicitly disable reasoning,
      // including the donor runtime's small title/summary calls. Keep the
      // campaign pinned to GLM and use its cheapest supported reasoning mode.
      reasoning: { effort: "low" },
      model: ResearchModel.DEFAULT.modelID,
      models: [ResearchModel.DEFAULT.modelID],
    }
  }

  function isAutofoldInference(input: {
    agent: string
    originatingAgent: string
    originatingProviderID?: string
    originatingModelID?: string
  }): boolean {
    return (
      input.agent.startsWith("autofold-") ||
      input.originatingAgent.startsWith("autofold-") ||
      (input.originatingProviderID !== undefined &&
        input.originatingModelID !== undefined &&
        ResearchModel.isResearchModel({
          providerID: input.originatingProviderID,
          modelID: input.originatingModelID,
        }))
    )
  }

  export async function modelTools(input: Pick<StreamInput, "tools" | "agent" | "model" | "user">) {
    if (!input.model.capabilities.toolcall) return {}
    return resolveTools(input)
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const wildcardDisable = input.user.tools?.["*"] === false
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (wildcardDisable || input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  export function isCodexSubscriptionModel(
    model: Pick<Provider.Model, "providerID">,
    auth?: Pick<Auth.Info, "type">,
  ): boolean {
    return model.providerID === "openai-codex" && auth?.type === "oauth"
  }
}
