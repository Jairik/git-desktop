/**
 * Entry point: mount <App/> inside the store provider.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { StoreProvider } from './state/store'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Missing #root element in index.html')
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>,
)
