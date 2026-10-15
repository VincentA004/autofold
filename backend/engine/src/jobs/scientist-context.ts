import type {PiContextPolicy} from '../runtime/types'

/** Scientific authoring uses Pi's ordinary compaction and exact tool archives.
 * Model/output defaults and explicit caller context policies remain authoritative. */
export function scientistContextPolicy(policy?:PiContextPolicy):PiContextPolicy {
  return {maxInputTokens:48000,keepRecentTokens:20000,retainedToolBytes:60000,
    retainLatestToolGroups:[['read_context','read_decision_memory'],['evaluate_trial']],...policy}
}
