// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => 'web'),
  setStyle: vi.fn(),
  setBackgroundColor: vi.fn(),
  addAppListener: vi.fn(),
  addNetworkListener: vi.fn(),
  removeAppListener: vi.fn(),
  removeNetworkListener: vi.fn(),
  minimizeApp: vi.fn(),
  impact: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({ Capacitor: native }))
vi.mock('@capacitor/app', () => ({ App: { addListener: native.addAppListener, minimizeApp: native.minimizeApp } }))
vi.mock('@capacitor/network', () => ({ Network: { addListener: native.addNetworkListener } }))
vi.mock('@capacitor/status-bar', () => ({ StatusBar: native, Style: { Light: 'LIGHT' } }))
vi.mock('@capacitor/haptics', () => ({ Haptics: native, ImpactStyle: { Medium: 'MEDIUM' } }))

import { cleanupNativePlatform, initializeNativePlatform, isNativeApp, nativeSuccessFeedback } from './native'

beforeEach(() => {
  vi.clearAllMocks()
  native.isNativePlatform.mockReturnValue(false)
  native.getPlatform.mockReturnValue('web')
  native.setStyle.mockResolvedValue(undefined)
  native.setBackgroundColor.mockResolvedValue(undefined)
  native.minimizeApp.mockResolvedValue(undefined)
  native.impact.mockResolvedValue(undefined)
  native.removeAppListener.mockResolvedValue(undefined)
  native.removeNetworkListener.mockResolvedValue(undefined)
  native.addAppListener.mockResolvedValue({ remove: native.removeAppListener })
  native.addNetworkListener.mockResolvedValue({ remove: native.removeNetworkListener })
})

afterEach(async () => {
  await cleanupNativePlatform()
  vi.restoreAllMocks()
})

describe('native platform lifecycle', () => {
  it('does not initialize plugins in a web browser', async () => {
    await initializeNativePlatform()
    await nativeSuccessFeedback()
    expect(isNativeApp()).toBe(false)
    expect(native.setStyle).not.toHaveBeenCalled()
    expect(native.addNetworkListener).not.toHaveBeenCalled()
    expect(native.impact).not.toHaveBeenCalled()
  })

  it('uses runtime detection even when Android serves the app over HTTPS', () => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('android')
    expect(isNativeApp()).toBe(true)
  })

  it('initializes Android once and uses dark status-bar text on the light app background', async () => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('android')
    await Promise.all([initializeNativePlatform(), initializeNativePlatform()])
    expect(native.setStyle).toHaveBeenCalledExactlyOnceWith({ style: 'LIGHT' })
    expect(native.setBackgroundColor).toHaveBeenCalledExactlyOnceWith({ color: '#f5f7fb' })
    expect(native.addAppListener).toHaveBeenCalledTimes(1)
    expect(native.addNetworkListener).toHaveBeenCalledTimes(1)
  })

  it('navigates Android history or minimizes the app when no history remains', async () => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('android')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined)
    await initializeNativePlatform()
    const callback = native.addAppListener.mock.calls[0][1] as (event: { canGoBack: boolean }) => void
    callback({ canGoBack: true })
    expect(back).toHaveBeenCalledOnce()
    expect(native.minimizeApp).not.toHaveBeenCalled()
    callback({ canGoBack: false })
    expect(native.minimizeApp).toHaveBeenCalledOnce()
  })

  it('does not install Android-only handlers on iOS and dispatches connectivity changes', async () => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('ios')
    await initializeNativePlatform()
    expect(native.addAppListener).not.toHaveBeenCalled()
    expect(native.setBackgroundColor).not.toHaveBeenCalled()
    const callback = native.addNetworkListener.mock.calls[0][1] as (status: { connected: boolean }) => void
    const receive = vi.fn()
    window.addEventListener('fitflow:network', receive, { once: true })
    callback({ connected: false })
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ detail: { connected: false } }))
  })

  it('removes only its own listeners and can initialize again', async () => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('android')
    await initializeNativePlatform()
    await cleanupNativePlatform()
    expect(native.removeAppListener).toHaveBeenCalledOnce()
    expect(native.removeNetworkListener).toHaveBeenCalledOnce()
    await initializeNativePlatform()
    expect(native.addAppListener).toHaveBeenCalledTimes(2)
  })

  it('keeps the application usable if an optional native plugin is unavailable', async () => {
    native.isNativePlatform.mockReturnValue(true)
    native.getPlatform.mockReturnValue('android')
    native.setStyle.mockRejectedValue(new Error('unavailable'))
    native.setBackgroundColor.mockRejectedValue(new Error('unavailable'))
    native.addAppListener.mockRejectedValue(new Error('unavailable'))
    native.addNetworkListener.mockRejectedValue(new Error('unavailable'))
    native.impact.mockRejectedValue(new Error('unavailable'))
    await expect(initializeNativePlatform()).resolves.toBeUndefined()
    await expect(nativeSuccessFeedback()).resolves.toBeUndefined()
  })
})
