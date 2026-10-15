export * from "../client.js"
export * from "./server.js"

import { createOpenScienceClient } from "../client.js"
import { createOpenScienceServer, type ServerOptions } from "./server.js"

/** Requires an independently installed historical OpenScience executable. */
export async function createOpenScience(options?: ServerOptions) {
  const server = await createOpenScienceServer(options)
  return { client: createOpenScienceClient({ baseUrl: server.url }), server }
}
