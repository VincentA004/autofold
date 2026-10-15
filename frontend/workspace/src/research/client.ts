export interface Campaign {id: string; objective: string; status: string; [key: string]: unknown}
export interface Experiment {id: string; campaignId: string; status: string; contractHash: string; contract: {objective: string; evaluator: {id: string; direction: string}; [key: string]: unknown}; piScientistSessionId?: string; [key: string]: unknown}
export interface ResearchJob {id: string; status: string; payload: {kind: string; experimentId?: string; campaignId?: string; sessionId?: string; [key: string]: unknown}; error?: string; result?: Record<string, unknown>; [key: string]: unknown}
export interface WorkspaceView {experiment: Experiment; root: string; sessionId: string | null; files: {path: string; bytes: number; mutable: boolean}[]; kernel: Record<string, unknown> | null}
export interface WorkspaceFile {path: string; content: string; hash: string; mutable: boolean}
export interface ResearchHistory {counts?:Record<string,number>;nextOffset?:number|null;coverage?:string;trials: Record<string, any>[]; evaluations: Record<string, any>[]; runs: Record<string, any>[]; knowledge: Record<string, any>[]}
export interface KnowledgeView {concepts: Record<string, any>[]; claims: Record<string, any>[]; literature: Record<string, any>[]; cycles: Record<string, any>[]; questions: Record<string, any>[]; observations: Record<string, any>[]}
export interface PiSession {id: string; messages: {role: string; content?: string | {type: string; text?: string; name?: string; arguments?: unknown}[]; toolName?: string; [key: string]: unknown}[]; [key: string]: unknown}
export interface PiMessageFragment {text:string;offsetBytes:number;nextOffsetBytes:number;totalBytes:number;hasMore:boolean;messageHash:string}
export interface PiTranscriptPage {session:Omit<PiSession,'messages'>;messages:PiSession['messages'];offset:number;nextOffset:number;anchor?:string;totalMessages:number;hasMore:boolean;reset:boolean}
export function apiURL(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter an HTTP backend URL without credentials or query parameters')
  return url.href.replace(/\/$/, '')
}
export type ResearchFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
export class ResearchHTTPError extends Error {constructor(readonly status:number,message:string){super(message);this.name='ResearchHTTPError'}}
export function refreshNeeds(tab:string){return {knowledge:tab==='knowledge',skills:tab==='skills',workspace:tab==='programs',history:['evidence','skills'].includes(tab),session:tab==='scientist'}}
export class ResearchClient {
  readonly baseURL: string
  constructor(url: string, private readonly token = '', private readonly fetcher: ResearchFetch = (...args) => fetch(...args)) {this.baseURL = apiURL(url)}
  async request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(this.baseURL + route, {method: body === undefined ? 'GET' : 'POST', headers: {...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(this.token ? {Authorization: `Bearer ${this.token}`} : {})}, body: body === undefined ? undefined : JSON.stringify(body), signal})
    const result = await response.json().catch(() => ({error: `Backend returned ${response.status}`}))
    if (!response.ok) throw new ResearchHTTPError(response.status,result.error ?? `Backend returned ${response.status}`)
    return result as T
  }
  campaigns() {return this.request<Campaign[]>('/research/campaigns')}
  experiments(campaign: string) {return this.request<Experiment[]>(`/research/campaigns/${encodeURIComponent(campaign)}/experiments`)}
  jobs() {return this.request<ResearchJob[]>('/research/jobs')}
  workspace(experiment: string) {return this.request<WorkspaceView>(`/research/experiments/${encodeURIComponent(experiment)}/workspace`)}
  file(experiment: string, file: string) {return this.request<WorkspaceFile>(`/research/experiments/${encodeURIComponent(experiment)}/workspace/file?path=${encodeURIComponent(file)}`)}
  history(experiment: string,offset=0) {return this.request<ResearchHistory>(`/research/experiments/${encodeURIComponent(experiment)}/history?limit=50&offset=${offset}`)}
  knowledge(campaign: string) {return this.request<KnowledgeView>(`/research/campaigns/${encodeURIComponent(campaign)}/knowledge`)}
  sessionPage(session:string,offset=0,anchor?:string){return this.request<PiTranscriptPage>(`/research/sessions/${encodeURIComponent(session)}/messages?limit=100&offset=${offset}${anchor?'&anchor='+encodeURIComponent(anchor):''}`)}
  messageFragment(session:string,index:number,offsetBytes:number,expectedHash:string){return this.request<PiMessageFragment>(`/research/sessions/${encodeURIComponent(session)}/messages/${index}/content?offsetBytes=${offsetBytes}&limitBytes=32768&expectedHash=${encodeURIComponent(expectedHash)}`)}
  session(session: string) {return this.request<PiSession>(`/research/sessions/${encodeURIComponent(session)}`)}
}
export function messageText(message: PiSession['messages'][number]) {
  if (typeof message.content === 'string') return message.content
  return message.content?.map(part => part.type === 'text' ? part.text ?? '' : part.type === 'toolCall' ? `${part.name}\n${JSON.stringify(part.arguments, null, 2)}` : '').filter(Boolean).join('\n') ?? ''
}
export const ongoing = (job: ResearchJob) => ['queued', 'running', 'retry_wait', 'interrupted', 'recovery_required'].includes(job.status)
export const blocksDiscovery = (job: ResearchJob) => ongoing(job) && !(['interrupted','recovery_required'].includes(job.status) && ['knowledge_refresh','knowledge_review'].includes(job.payload.kind))

export function appendTranscriptPage(prior:PiSession|null,page:PiTranscriptPage,maximumMessages=400):PiSession {
 const messages=[...(page.reset?[]:prior?.messages??[]),...page.messages]
 return {...page.session,messages:messages.slice(-maximumMessages)} as PiSession
}
