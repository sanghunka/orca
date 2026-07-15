import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

// Repro for #8038: a macOS Hangul composition committed by Enter must deliver
// the committed syllable to the PTY *before* the newline. The committing
// Enter's keydown arrives as an IME Process key (229) and is suppressed; its
// trailing keypress used to reach xterm's _keyPress and send \r synchronously
// while the committed glyph was still waiting on xterm's post-compositionend
// setTimeout(0) flush — so the last syllable landed after the newline.

type ImeEventLogEntry = {
  type: string
  at: number
  data: string | null
  key: string | null
  keyCode: number | null
  isComposing: boolean | null
}

const PROMPT = '› '

function stripTerminalControls(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x1b) {
      const next = value[index + 1]
      if (next === ']') {
        index += 2
        while (index < value.length) {
          const current = value.charCodeAt(index)
          if (current === 0x07) {
            break
          }
          if (current === 0x1b && value[index + 1] === '\\') {
            index += 1
            break
          }
          index += 1
        }
        continue
      }
      if (next === '[') {
        index += 2
        while (index < value.length && value.charCodeAt(index) < 0x40) {
          index += 1
        }
        continue
      }
      continue
    }
    if ((code >= 0 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f) {
      continue
    }
    output += value[index]
  }
  return output
}

function terminalImeHarnessScript(runId: string): string {
  return `
const runId = ${JSON.stringify(runId)}
let model = ''
const submitted = []

function emitState() {
  process.stdout.write('\\r\\x1b[2K${PROMPT}' + model)
}

function handleData(data) {
  for (const ch of data) {
    if (ch === '\\u0003') {
      process.exit(0)
    }
    if (ch === '\\r' || ch === '\\n') {
      submitted.push(model)
      process.stdout.write('\\r\\x1b[2K[SUBMITTED_JSON_' + runId + ']' + JSON.stringify(model) + '\\n')
      model = ''
      continue
    }
    if (ch === '\\u007f' || ch === '\\b') {
      model = Array.from(model).slice(0, -1).join('')
      continue
    }
    model += ch
  }
  emitState()
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write('IME_HARNESS_READY_' + runId + '\\n')
emitState()
process.stdin.on('data', handleData)
`
}

async function installImeEventProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as unknown as { __orcaImeEventLog?: ImeEventLogEntry[] }
    targetWindow.__orcaImeEventLog = []
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!textarea) {
      throw new Error('No terminal helper textarea')
    }
    const record = (event: Event): void => {
      const composition = event instanceof CompositionEvent ? event : null
      const keyboard = event instanceof KeyboardEvent ? event : null
      targetWindow.__orcaImeEventLog!.push({
        type: event.type,
        at: performance.now(),
        data: composition?.data ?? null,
        key: keyboard?.key ?? null,
        keyCode: keyboard?.keyCode ?? null,
        isComposing: keyboard?.isComposing ?? null
      })
    }
    // Why: keypress is the event under test (#8038) — the committing Enter's
    // keypress must be observable to prove the repro exercises the real shape.
    for (const type of [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'keydown',
      'keypress',
      'keyup'
    ]) {
      textarea.addEventListener(type, record, true)
    }
  })
}

async function readImeEventLog(page: Page): Promise<ImeEventLogEntry[]> {
  return page.evaluate(() => {
    const targetWindow = window as unknown as { __orcaImeEventLog?: ImeEventLogEntry[] }
    return targetWindow.__orcaImeEventLog ?? []
  })
}

async function readSubmitted(page: Page): Promise<string[]> {
  const content = stripTerminalControls(await getTerminalContent(page, 20_000))
  const matches = [...content.matchAll(/\[SUBMITTED_JSON_[^\]]+\]("[\s\S]*?")/g)]
  return matches
    .map((match) => {
      try {
        return JSON.parse(match[1] ?? '""') as string
      } catch {
        return null
      }
    })
    .filter((value): value is string => value !== null)
}

async function attachImeEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const evidence = {
    terminal: await getTerminalContent(page, 20_000),
    submitted: await readSubmitted(page),
    imeEvents: await readImeEventLog(page)
  }
  await testInfo.attach(`${name}.json`, {
    body: `${JSON.stringify(evidence, null, 2)}\n`,
    contentType: 'application/json'
  })
}

async function dispatchHangulProcessKey(
  session: CDPSession,
  key: string,
  code: string
): Promise<void> {
  // Why: macOS Hangul jamo keydowns arrive as IME Process keys (keyCode 229)
  // with the jamo in `key`; the release carries the physical keyCode.
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
}

async function composeHangulSyllable(session: CDPSession, page: Page): Promise<void> {
  await dispatchHangulProcessKey(session, 'ㅎ', 'KeyG')
  await session.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
  await dispatchHangulProcessKey(session, 'ㅏ', 'KeyK')
  await session.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
}

async function commitSyllableAndSpace(session: CDPSession, page: Page): Promise<void> {
  await session.send('Input.insertText', { text: '하' })
  await page.waitForTimeout(60)
  await page.keyboard.press('Space')
  await page.waitForTimeout(60)
}

/**
 * The committing Enter, macOS Hangul keypress shape: keydown arrives as an IME
 * Process key (229, isComposing=true) and is suppressed; the IME then commits;
 * Chromium delivers Enter's keypress (charCode 13) after compositionend.
 *
 * Why one un-awaited burst: the real IME delivers commit and keypress in the
 * same native key-processing turn, ahead of xterm's queued setTimeout(0) glyph
 * flush. Awaiting each CDP round-trip inserts milliseconds between them, the
 * flush timer wins the race, and the pre-fix bug becomes unreproducible.
 */
async function dispatchCommittingEnterWithKeypress(session: CDPSession): Promise<void> {
  await Promise.all([
    session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      text: '',
      unmodifiedText: ''
    }),
    session.send('Input.insertText', { text: '하' }),
    session.send('Input.dispatchKeyEvent', {
      type: 'char',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r'
    }),
    session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  ])
}

/**
 * The committing Enter, macOS re-dispatched keydown shape: after the suppressed
 * 229 keydown and the commit, the IME re-sends a plain Enter keydown
 * (keyCode 13, no keypress). xterm's CompositionHelper flushes the pending
 * glyph synchronously before encoding \r, so this shape orders correctly on
 * its own — the guard must stay out of its way (exactly one newline).
 */
async function dispatchCommittingEnterWithRedispatchedKeydown(session: CDPSession): Promise<void> {
  await Promise.all([
    session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      text: '',
      unmodifiedText: ''
    }),
    session.send('Input.insertText', { text: '하' }),
    session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '',
      unmodifiedText: ''
    }),
    session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  ])
}

test.describe('Korean IME terminal Enter commit (#8038)', () => {
  for (const [shape, dispatchCommittingEnter, description] of [
    [
      'keypress',
      dispatchCommittingEnterWithKeypress,
      'commits the trailing Hangul syllable before the newline when Enter ends the composition'
    ],
    [
      're-dispatched keydown',
      dispatchCommittingEnterWithRedispatchedKeydown,
      'sends exactly one newline when the IME re-dispatches the committing Enter keydown'
    ]
  ] as const) {
    test(description, async ({ orcaPage, testRepoPath }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)

      const ptyId = await waitForActivePanePtyId(orcaPage)
      const runId = randomUUID()
      const scriptPath = path.join(testRepoPath, `.orca-korean-ime-harness-${runId}.cjs`)
      const session = await orcaPage.context().newCDPSession(orcaPage)

      try {
        writeFileSync(scriptPath, terminalImeHarnessScript(runId))
        await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
        await waitForTerminalOutput(orcaPage, `IME_HARNESS_READY_${runId}`, 10_000, 20_000)
        await focusActiveTerminalInput(orcaPage)
        await installImeEventProbe(orcaPage)

        // 하 하 하 — first two syllables committed by Space, the last one left
        // composing so Enter is the committing keystroke.
        await composeHangulSyllable(session, orcaPage)
        await commitSyllableAndSpace(session, orcaPage)
        await composeHangulSyllable(session, orcaPage)
        await commitSyllableAndSpace(session, orcaPage)
        await composeHangulSyllable(session, orcaPage)
        await dispatchCommittingEnter(session)

        await expect
          .poll(async () => (await readSubmitted(orcaPage)).at(-1) ?? null, {
            timeout: 10_000,
            message: `submitted line must contain the full text with the trailing syllable inline (${shape} shape)`
          })
          .toBe('하 하 하')

        // Exactly one submission: a doubled newline would push a second,
        // empty entry (the pre-fix helper-textarea line-break leak).
        await orcaPage.waitForTimeout(500)
        expect(
          await readSubmitted(orcaPage),
          `the committing Enter must produce exactly one newline (${shape} shape)`
        ).toEqual(['하 하 하'])

        const log = await readImeEventLog(orcaPage)
        expect(
          log.some((entry) => entry.type === 'compositionend' && entry.data === '하'),
          'repro must commit the trailing syllable through a real compositionend'
        ).toBe(true)
        if (shape === 'keypress') {
          const endIndex = log.findIndex(
            (entry) => entry.type === 'compositionend' && entry.data === '하'
          )
          const keypressIndex = log.findIndex(
            (entry, index) => index > endIndex && entry.type === 'keypress' && entry.keyCode === 13
          )
          expect(
            keypressIndex,
            'the committing Enter keypress must arrive after compositionend to exercise the #8038 shape'
          ).toBeGreaterThan(endIndex)
        }
        await attachImeEvidence(orcaPage, testInfo, `korean-enter-${shape.replace(/\s+/g, '-')}`)
      } finally {
        await attachImeEvidence(orcaPage, testInfo, 'korean-final-ime-evidence').catch(
          () => undefined
        )
        await session.detach().catch(() => undefined)
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
        rmSync(scriptPath, { force: true })
      }
    })
  }
})
