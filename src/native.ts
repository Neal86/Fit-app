import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Network } from '@capacitor/network'
import { StatusBar, Style } from '@capacitor/status-bar'

export async function initializeNativePlatform() {
  if (!Capacitor.isNativePlatform()) return

  await StatusBar.setStyle({ style: Style.Light }).catch(() => undefined)
  if (Capacitor.getPlatform() === 'android') {
    await StatusBar.setBackgroundColor({ color: '#0f172a' }).catch(() => undefined)
  }

  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back()
    else App.minimizeApp()
  })

  Network.addListener('networkStatusChange', (status) => {
    window.dispatchEvent(new CustomEvent('fitflow:network', { detail: status }))
  })
}

export async function nativeSuccessFeedback() {
  if (!Capacitor.isNativePlatform()) return
  await Haptics.impact({ style: ImpactStyle.Medium }).catch(() => undefined)
}

export function isNativeApp() {
  return Capacitor.isNativePlatform()
}
