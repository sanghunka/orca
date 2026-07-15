// Why: the newline of a composition-committing Enter must reach the PTY
// *after* the committed glyph. xterm flushes the glyph asynchronously — a
// `setTimeout(0)` scheduled inside its compositionend handler — while the
// suppressed Enter keypress fires synchronously, so sending `\r` at keypress
// time would land it ahead of the syllable it committed (#8038).

// Why: compositionend fires within the same event-loop turn as the committing
// key, so a real commit resolves well under this bound. The fallback only
// guards against an IME that never emits compositionend, so the newline is
// not silently swallowed.
export const TERMINAL_IME_ENTER_COMMIT_NEWLINE_FALLBACK_MS = 200

/**
 * Sends the deferred newline of a composition-committing Enter exactly once.
 *
 * When the composition has already ended (macOS Hangul: compositionend
 * precedes the Enter keypress in the same turn), xterm's glyph flush is
 * already queued, so one macrotask hop is enough to order `send()` after it.
 * When the composition is still open, a bubble-phase compositionend listener
 * (running after xterm's own capture-side handler queues the flush) plus the
 * same macrotask hop gives the identical ordering.
 */
export function sendTerminalEnterAfterImeCommit(args: {
  terminalElement: HTMLElement | null | undefined
  isCompositionActive: () => boolean
  send: () => void
  fallbackMs?: number
}): void {
  const { terminalElement, isCompositionActive, send } = args

  if (!terminalElement || !isCompositionActive()) {
    window.setTimeout(send, 0)
    return
  }

  const fallbackMs = args.fallbackMs ?? TERMINAL_IME_ENTER_COMMIT_NEWLINE_FALLBACK_MS
  let done = false

  const finish = (): void => {
    if (done) {
      return
    }
    done = true
    terminalElement.removeEventListener('compositionend', onCompositionEnd)
    window.clearTimeout(fallbackTimer)
    window.setTimeout(send, 0)
  }

  const onCompositionEnd = (): void => finish()

  terminalElement.addEventListener('compositionend', onCompositionEnd)
  const fallbackTimer = window.setTimeout(finish, fallbackMs)
}
