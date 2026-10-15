import { createOpenScienceClient } from "@synsci/sdk"

// Connect to an existing server implementing the generated legacy API contract.
const baseUrl = process.env.OPENSCIENCE_URL
if (!baseUrl) throw new Error("Set OPENSCIENCE_URL to an existing OpenScience API server")

const client = createOpenScienceClient({ baseUrl })
console.log(await client.session.list())
