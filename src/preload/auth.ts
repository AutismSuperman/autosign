/// <reference lib="dom" />

import { contextBridge, ipcRenderer } from 'electron'
import { AUTH_INTERACTIVE_IPC } from '../shared/authWindow'

// Install before page scripts; no IPC or local application API is exposed to the page.
const updateInteractive: (value: boolean) => void = contextBridge.executeInMainWorld({
  func: () => {
    if (!navigator.credentials) return (): void => {}
    let interactive = false
    let lastInteraction = -Infinity
    for (const event of ['click', 'keydown']) {
      window.addEventListener(event, (e) => {
        if (e.isTrusted && interactive) lastInteraction = performance.now()
      }, true)
    }
    const prototype = Object.getPrototypeOf(navigator.credentials)
    for (const method of ['get', 'create']) {
      const original = prototype[method]
      if (typeof original !== 'function') continue
      prototype[method] = function (
        options?: CredentialRequestOptions | CredentialCreationOptions
      ): Promise<Credential | null> {
        if (options?.publicKey) {
          const userGesture = performance.now() - lastInteraction < 30_000
          if (!interactive || !userGesture) {
            return Promise.reject(new DOMException(
              'Passkey authentication requires an active authorization window and user interaction.',
              'NotAllowedError'
            ))
          }
          // Consume the interaction even if the native request fails or is cancelled.
          lastInteraction = -Infinity
        }
        return original.call(this, options)
      }
    }
    return (value: boolean): void => {
      interactive = value === true
      if (!interactive) lastInteraction = -Infinity
    }
  }
})
ipcRenderer.on(AUTH_INTERACTIVE_IPC, (_event, value: boolean) => {
  updateInteractive(value === true)
})
