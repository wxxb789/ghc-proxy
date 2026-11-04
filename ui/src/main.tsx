import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToolchainProbe } from './toolchain-probe'
import './styles/index.css'

const root = document.getElementById('root')
if (!root)
  throw new Error('Dashboard root element is missing')

createRoot(root).render(<StrictMode><ToolchainProbe /></StrictMode>)
