// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTerminalEnterAfterImeCommit } from './terminal-ime-enter-commit-newline'

describe('sendTerminalEnterAfterImeCommit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hops one macrotask when the composition already ended', () => {
    // Why: macOS Hangul delivers the Enter keypress after compositionend, so
    // xterm's glyph flush is already queued — one hop orders the newline last.
    const element = document.createElement('div')
    const send = vi.fn()

    sendTerminalEnterAfterImeCommit({
      terminalElement: element,
      isCompositionActive: () => false,
      send
    })
    expect(send).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('waits for compositionend before the macrotask hop while composing', () => {
    const element = document.createElement('div')
    const send = vi.fn()

    sendTerminalEnterAfterImeCommit({
      terminalElement: element,
      isCompositionActive: () => true,
      send
    })
    expect(send).not.toHaveBeenCalled()

    element.dispatchEvent(new Event('compositionend'))
    expect(send).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('falls back when no compositionend ever arrives', () => {
    const element = document.createElement('div')
    const send = vi.fn()

    sendTerminalEnterAfterImeCommit({
      terminalElement: element,
      isCompositionActive: () => true,
      send
    })
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends only once when compositionend follows the fallback', () => {
    const element = document.createElement('div')
    const send = vi.fn()

    sendTerminalEnterAfterImeCommit({
      terminalElement: element,
      isCompositionActive: () => true,
      send
    })
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not re-fire on a later composition', () => {
    const element = document.createElement('div')
    const send = vi.fn()

    sendTerminalEnterAfterImeCommit({
      terminalElement: element,
      isCompositionActive: () => true,
      send
    })
    element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    element.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('still delivers without a terminal element', () => {
    const send = vi.fn()

    sendTerminalEnterAfterImeCommit({
      terminalElement: null,
      isCompositionActive: () => true,
      send
    })
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
  })
})
