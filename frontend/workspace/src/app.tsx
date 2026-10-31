import '@/index.css'
import { ErrorBoundary, type ParentProps } from 'solid-js'
import { ThemeProvider } from '@synsci/ui/theme/context'
import CampaignWorkspace from './campaign/Workspace'
import CampaignChooser from './campaign/CampaignChooser'
import { archiveClient } from './campaign/client'

export function AppBaseProviders(props: ParentProps) {
  return <ThemeProvider><ErrorBoundary fallback={(error, reset) => <main style={{ padding: '32px', color: '#e6e5e2', background: '#171717', height: '100vh' }}><h1>Workspace unavailable</h1><p>{error instanceof Error ? error.message : String(error)}</p><button onClick={reset}>Try again</button></main>}>{props.children}</ErrorBoundary></ThemeProvider>
}
export function AppInterface() { return archiveClient.campaign ? <CampaignWorkspace /> : <CampaignChooser /> }
