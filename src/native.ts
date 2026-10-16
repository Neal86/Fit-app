import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Network } from '@capacitor/network'
import { StatusBar, Style } from '@capacitor/status-bar'

let initialization: Promise<void> | undefined
const listeners: PluginListenerHandle[] = []

async function retainListener(pending: Promise<PluginListenerHandle>) {
  try { listeners.push(await pending) } catch { /* Optional native integration. */ }
}

export function initializeNativePlatform(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve()
  if (initialization) return initialization

  initialization = (async () => {
    // Capacitor names this for the background: LIGHT means dark text.
    await StatusBar.setStyle({ style: Style.Light }).catch(() => undefined)
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: '#f5f7fb' }).catch(() => undefined)
      await retainListener(App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) window.history.back()
        else void App.minimizeApp().catch(() => undefined)
      }))
    }

    await retainListener(Network.addListener('networkStatusChange', (status) => {
      window.dispatchEvent(new CustomEvent('fitflow:network', { detail: status }))
    }))
  })()
  return initialization
}

export async function cleanupNativePlatform() {
  await initialization
  await Promise.all(listeners.splice(0).map((listener) => listener.remove().catch(() => undefined)))
  initialization = undefined
}

export async function nativeSuccessFeedback() {
  if (!Capacitor.isNativePlatform()) return
  await Haptics.impact({ style: ImpactStyle.Medium }).catch(() => undefined)
}

export function isNativeApp() {
  return Capacitor.isNativePlatform()
}
