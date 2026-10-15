export * from "./types"
export * from "./http"
import { ConnectorRegistry } from "./types"
import { HttpClient } from "./http"
import { createPubmed } from "./literature/pubmed"
import { createEuropepmc } from "./literature/europepmc"
import { createOpenalex } from "./literature/openalex"
import { createSemanticScholar } from "./literature/semantic-scholar"
import { createCrossref } from "./literature/crossref"
import { createBiorxiv } from "./literature/biorxiv"
import { createArxiv } from "./literature/arxiv"
export function createLiteratureRegistry(http = new HttpClient()) {
 const registry = new ConnectorRegistry()
 registry.register(createPubmed(http))
 registry.register(createEuropepmc(http))
 registry.register(createOpenalex(http))
 registry.register(createSemanticScholar(http))
 registry.register(createCrossref(http))
 registry.register(createBiorxiv(http))
 registry.register(createArxiv(http))
 return registry
}
