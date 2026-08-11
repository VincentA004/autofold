export namespace ResearchModel {
  export type Selection = { modelID: string; providerID: string }

  /**
   * Autofold research workers intentionally do not inherit the interactive
   * donor runtime's model. Campaign fan-out must have an explicit, predictable
   * cost profile independent of whichever model happens to power the parent
   * chat session.
   */
  export const DEFAULT: Selection = {
    providerID: "openrouter",
    modelID: "deepseek/deepseek-v4-flash-0731",
  }

  export function select(): Selection {
    const override = process.env.AUTOFOLD_RESEARCH_MODEL?.trim()
    if (override) {
      const separator = override.indexOf(":")
      if (separator <= 0 || separator === override.length - 1) {
        throw new Error("AUTOFOLD_RESEARCH_MODEL must use provider:model format")
      }
      return { providerID: override.slice(0, separator), modelID: override.slice(separator + 1) }
    }
    return DEFAULT
  }
}
