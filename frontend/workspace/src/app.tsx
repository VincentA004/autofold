import '@/index.css'
import {ErrorBoundary, type ParentProps} from 'solid-js'
import {MetaProvider} from '@solidjs/meta'
import {I18nProvider} from '@synsci/ui/context'
import {ThemeProvider} from '@synsci/ui/theme'
import {DialogProvider} from '@synsci/ui/context/dialog'
import {LanguageProvider, useLanguage} from '@/context/language'
import {ErrorPage} from './pages/error'
import ResearchWorkspace from './research/workspace'
function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{locale: language.locale, t: language.t}}>{props.children}</I18nProvider>
}
declare global {
  interface Window {
    __OPENSCIENCE__?: {updaterEnabled?: boolean; deepLinks?: string[]}
    __OPENSCIENCE_BASE_URL__?: string
  }
}
export function AppBaseProviders(props: ParentProps) {
  return <MetaProvider><ThemeProvider><LanguageProvider><UiI18nBridge><ErrorBoundary fallback={error => <ErrorPage error={error} />}><DialogProvider>{props.children}</DialogProvider></ErrorBoundary></UiI18nBridge></LanguageProvider></ThemeProvider></MetaProvider>
}
/** The research product talks directly to the Pi API. Scientific visualizers remain reusable modules. */
export function AppInterface(props: {defaultUrl?: string}) {
  return <ResearchWorkspace defaultUrl={props.defaultUrl} />
}
