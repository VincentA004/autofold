import { type Config } from "../../v2/gen/types.gen.js"
import { createOpenScienceServer as launch, type ServerOptions as SharedOptions } from "../server-process.js"
export type ServerOptions = Omit<SharedOptions, 'config'> & {config?: Config}
/** Compatibility export; both SDK versions share one process implementation. */
export function createOpenScienceServer(options?: ServerOptions) { return launch(options) }
