import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { cleanupNativePlatform, initializeNativePlatform, isNativeApp } from './native'
import './styles.css'
import './runtime.css'
import './native.css'

class ErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="fatal-error">
          <div>
            <strong>FitFlow</strong>
            <h1>Something went wrong.</h1>
            <p>Your saved fitness data is still on this device.</p>
            <button onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}

void initializeNativePlatform()
import.meta.hot?.dispose(() => { void cleanupNativePlatform() })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
