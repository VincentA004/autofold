import { render } from 'solid-js/web'
import { AppBaseProviders, AppInterface } from './app'
const root = document.getElementById('root')
if (!root) throw new Error('Workspace root is missing')
render(() => <AppBaseProviders><AppInterface /></AppBaseProviders>, root)
