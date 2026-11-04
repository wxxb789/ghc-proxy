import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DashboardPages } from './app/pages'
import { DashboardRoot } from './app/root'
import './styles/index.css'

const root = document.getElementById('root')
if (!root)
  throw new Error('Dashboard root element is missing')

createRoot(root).render(
  <StrictMode>
    <DashboardRoot fetch={(input, init) => window.fetch(input, init)}>
      <DashboardPages />
    </DashboardRoot>
  </StrictMode>,
)
