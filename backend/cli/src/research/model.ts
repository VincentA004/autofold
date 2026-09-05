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
    modelID: "z-ai/glm-5.3-flash",
  }

  export function select(): Selection {
    // The campaign model is intentionally pinned. Ignore stale or accidental
    // operator overrides instead of failing a campaign or routing it elsewhere.
    return DEFAULT
  }

  export function forceResearchModel(_selection?: Selection): Selection {
    return DEFAULT
  }

  export function isResearchModel(selection: Selection): boolean {
    return selection.providerID === DEFAULT.providerID && selection.modelID === DEFAULT.modelID
  }
}
