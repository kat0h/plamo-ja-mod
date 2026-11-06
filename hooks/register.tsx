import type { EngineInterface, Register } from 'claude-code'

type Config = { endpoint: string; model: string; form: string }

// Sent once, as hidden context on the next prompt after `/plamo on`.
const ENGLISH_ON =
  'Japanese display mode is on. The user reads every reply through a local English-to-Japanese machine ' +
  'translator (PLaMo), so from now on write all user-facing text in English, even when the user writes in ' +
  'Japanese. Do not write Japanese yourself. Use plain, complete sentences that translate well, and put code, ' +
  'commands and paths in backticks or fenced blocks. Write AskUserQuestion questions and options in English ' +
  'too; they are translated before they are shown. This lasts until the user turns the mode off.'
// Sent instead of ENGLISH_ON by `/plamo on-input`.
const ENGLISH_ON_INPUT =
  ENGLISH_ON +
  " The user's messages are also machine-translated from Japanese into English before you read them, so " +
  'they may contain translation errors; when a request seems odd, ask instead of guessing.'
const ENGLISH_OFF = 'Japanese display mode is off. Reply in Japanese again, as before.'

// What PLaMo is told about the text it translates (the PFML3 context tag).
const REPLY_CONTEXT =
  'Replies from an AI coding assistant (Claude Code) to a Japanese software ' +
  'developer in a terminal. Technical terms, file paths, commands and code stay as-is.'
const PROMPT_CONTEXT =
  'Requests from a Japanese software developer to an AI coding assistant (Claude Code) ' +
  'in a terminal. Technical terms, file paths, commands and code stay as-is.'

type Direction = { from: 'en' | 'ja'; to: 'en' | 'ja'; context: string }
const TO_JA: Direction = { from: 'en', to: 'ja', context: REPLY_CONTEXT } // replies, questions
const TO_EN: Direction = { from: 'ja', to: 'en', context: PROMPT_CONTEXT } // the user's prompts
const HISTORY_BUDGET = 8000 // max chars of earlier (English, Japanese) pairs sent as context

const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g
const ALPHA = /[A-Za-z]/g

// off: nothing is translated. on: replies and questions. on-input: also the user's prompts.
type Mode = 'off' | 'on' | 'on-input'
let mode: Mode = 'off'
// The mode Claude was last told about, and the instruction the next prompt carries (if any).
// A command's own context would start a turn of its own, so the instruction waits for the user's next prompt.
let instructed: Mode = 'off'
let instruction: string | undefined
const INSTRUCTIONS: Record<Mode, string> = { off: ENGLISH_OFF, on: ENGLISH_ON, 'on-input': ENGLISH_ON_INPUT }
// English text -> Japanese. Insertion order is translation order, so it doubles as the context history.
const cache = new Map<string, string>()
// English sent to Claude -> the Japanese the user typed, to show the prompt as typed while on-input.
const inputs = new Map<string, string>()
const failed = new Map<string, string>() // English text -> reason; cleared on the next prompt so it is retried
// Texts waiting for translation, in order. A reply joins only once its response is whole (turn.step),
// and leaves while it is scrolled off screen, so a resumed session translates what is shown first.
const queue: string[] = []
// True while a main-loop response streams: the drafts drawn then are not translated.
let isResponding = false
let historyStart = 0
let isBusy = false

function escape(text: string): string {
  return text.replaceAll('<|plamo:', '<|plamo :')
}

function hasJapanese(text: string): boolean {
  return (text.match(JA)?.length ?? 0) > 0
}

/** Nothing to translate: no English letters, or mostly Japanese already. */
function isUntranslatable(text: string): boolean {
  const alpha = text.match(ALPHA)?.length ?? 0
  const ja = text.match(JA)?.length ?? 0
  return alpha === 0 || ja * 3 > alpha
}

/**
 * The earlier pairs to send. The start only jumps in big steps (down to half the budget), so the
 * prompt prefix stays the same between jumps and llama-server's prompt cache keeps hitting.
 */
function history(): [string, string][] {
  const pairs = [...cache]
  historyStart = Math.min(historyStart, pairs.length)
  const size = (from: number) => pairs.slice(from).reduce((n, [en, ja]) => n + en.length + ja.length, 0)
  if (size(historyStart) > HISTORY_BUDGET) {
    while (historyStart < pairs.length && size(historyStart) > HISTORY_BUDGET / 2) historyStart++
  }
  return pairs.slice(historyStart)
}

/** A PFML3 prompt; `pairs` are earlier (source, translation) pairs in the same direction. */
function pfml3(text: string, dir: Direction, form: string, pairs: [string, string][]): string {
  const input = `<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>${dir.from}<|plamo:msg|>`
  const output = `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${dir.to}`
  let prompt = `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>context<|plamo:msg|>${dir.context}`
  for (const [source, translation] of pairs) {
    prompt += `${input}${escape(source)}${output}<|plamo:msg|>${escape(translation)}`
  }
  // form (です・ます / だ・である) applies to Japanese output only.
  const style = dir.to === 'ja' ? `<|plamo:key|>form<|plamo:val|>${form}` : ''
  return `${prompt}${input}${escape(text)}${output}${style}<|plamo:msg|>`
}

async function translate(
  $: EngineInterface,
  config: Config,
  text: string,
  pairs: [string, string][] = [],
  dir: Direction = TO_JA,
): Promise<string> {
  // The GGUF build's bundled chat template ignores chat_template_kwargs, so the PFML3 prompt goes to the Completions API as is.
  const res = await $.http.fetch(`${config.endpoint.replace(/\/+$/, '')}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt: pfml3(text, dir, config.form, pairs),
      temperature: 0,
      max_tokens: 8192,
      stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
      // llama-server: keep every request on one slot so the shared prefix (context, history) is reused.
      cache_prompt: true,
      id_slot: 0,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const translation: string = JSON.parse(res.text).choices[0].text.trim()
  if (!translation) throw new Error('empty output')
  return translation
}

/** Translates a short UI string (no history), cached; the English on any failure. */
async function translateShort($: EngineInterface, config: Config, text: string): Promise<string> {
  if (!text.trim() || isUntranslatable(text)) return text
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  try {
    const japanese = await translate($, config, text)
    cache.set(text, japanese)
    return japanese
  } catch {
    return text
  }
}

function pending(): string[] {
  return queue.filter(t => !cache.has(t) && !failed.has(t))
}

function enqueue(text: string): void {
  if (!queue.includes(text)) queue.push(text)
}

function dequeue(text: string): void {
  const i = queue.indexOf(text)
  if (i >= 0) queue.splice(i, 1)
}

function withNote(text: string, note: string): string {
  return `${text}\n\n---\n*${note}*`
}

async function pump($: EngineInterface, config: Config): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    for (;;) {
      if (mode === 'off') break
      const [text] = pending()
      if (text === undefined) break
      $.ui.status(`PLaMo 翻訳中 (残り ${pending().length} 件)`)
      try {
        const japanese = await translate($, config, text, history())
        cache.set(text, japanese)
      } catch (err) {
        failed.set(text, err instanceof Error ? err.message : String(err))
      }
      dequeue(text)
      $.ui.invalidate('ui.render')
    }
  } finally {
    isBusy = false
    $.ui.status(undefined)
  }
}

type Question = {
  question: string
  header: string
  options: { label: string; description: string; preview?: string }[]
  multiSelect: boolean
}

async function translateQuestion($: EngineInterface, config: Config, q: Question): Promise<Question> {
  const t = (s: string) => translateShort($, config, s)
  const [question, header] = await Promise.all([t(q.question), t(q.header)])
  const options = await Promise.all(
    q.options.map(async o => ({ ...o, label: await t(o.label), description: await t(o.description) })),
  )
  // Options must stay distinct and non-empty; if the translation breaks that, keep the English labels.
  const labels = options.map(o => o.label.trim())
  const isLabelSafe = labels.every(Boolean) && new Set(labels).size === labels.length
  return {
    ...q,
    question,
    header,
    options: isLabelSafe ? options : options.map((o, i) => ({ ...o, label: q.options[i]!.label })),
  }
}

export const register: Register = (on, options) => {
  const config: Config = {
    endpoint: String(options.endpoint),
    model: String(options.model),
    form: String(options.form),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plamo',
      description: 'PLaMo で応答を日本語表示する (on / on-input で入力も英訳 / off)',
      argumentHint: '[on|on-input|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'plamo' }, async ($, e) => {
    const arg = e.args.trim() || 'on'
    if (arg !== 'on' && arg !== 'on-input' && arg !== 'off') return { text: '使い方: /plamo [on|on-input|off]' }
    mode = arg
    // Running it again re-sends the instruction (after /compact, say); off needs none if Claude was never told.
    instruction = mode === 'off' && instructed === 'off' ? undefined : INSTRUCTIONS[mode]
    if (mode === 'off') $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    const label = { on: 'オン', 'on-input': 'オン (入力も英訳して送信)', off: 'オフ' }[mode]
    return { text: `PLaMo 日本語表示: ${label}` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    let out = e
    if (instruction !== undefined) {
      out = { ...e, context: [...(e.context ?? []), instruction] }
      instructed = mode
      instruction = undefined
    }
    if (mode === 'off') return next(out)
    if (failed.size > 0) {
      failed.clear()
      $.ui.invalidate('ui.render')
    }
    // on-input: the user's own typed Japanese goes to Claude in English.
    if (mode !== 'on-input' || e.origin.kind !== 'composer' || !hasJapanese(e.text)) return next(out)
    $.ui.status('PLaMo 翻訳中 (入力)')
    let english: string
    try {
      english = await translate($, config, e.text, [], TO_EN)
    } catch (err) {
      $.ui.toast(`⚠ PLaMo 入力の翻訳に失敗したので原文のまま送ります (${err instanceof Error ? err.message : String(err)})`)
      return next(out)
    } finally {
      $.ui.status(undefined)
    }
    inputs.set(english, e.text)
    return next({ ...out, text: english })
  }).catch(($, e, next) => next(e)) // never hold up the prompt over the retry bookkeeping

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (mode === 'off') return next(e)
    $.ui.status('PLaMo 翻訳中 (質問)')
    try {
      const questions = await Promise.all(e.questions.map(q => translateQuestion($, config, q)))
      return next({ ...e, questions })
    } finally {
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => next(e)) // never block the question: show the English if translating throws

  // A response is translated once it is whole: its text blocks join the queue when the step ends.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || mode === 'off') return yield* next(e)
    const blocks = new Map<number, string>()
    const stream = next(e)
    isResponding = true
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done) return step.value
        const chunk = step.value
        if (chunk.kind === 'text') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text)
        yield chunk
      }
    } finally {
      isResponding = false
      if ((mode as Mode) !== 'off') {
        for (const [, text] of [...blocks].sort(([a], [b]) => a - b)) {
          const key = text.trim()
          if (key && !isUntranslatable(key)) enqueue(key)
        }
        $.ui.invalidate('ui.render')
        void pump($, config)
      }
    }
  })

  // While on-input, the user's prompts show as typed; in any other mode, as sent (English).
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const typed = mode === 'on-input' ? inputs.get(e.props.text) : undefined
    return typed === undefined ? next(e) : next({ ...e, props: { ...e.props, text: typed } })
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = e.props.text.trim()
    if (mode === 'off' || e.props.isSummary || isUntranslatable(text)) return next(e)
    const japanese = cache.get(text)
    if (japanese !== undefined) return next({ ...e, props: { ...e.props, text: japanese } })
    const reason = failed.get(text)
    if (reason !== undefined) {
      const note = `⚠ PLaMo 翻訳に失敗しました (${reason})。${config.endpoint} のサーバを確認してください。次のメッセージ送信時に再試行します`
      return next({ ...e, props: { ...e.props, text: withNote(e.props.text, note) } })
    }
    // Off screen (null; absent where the surface does not say): wait until it is scrolled into view.
    if (e.props.onScreen === null) {
      dequeue(text)
      return next({ ...e, props: { ...e.props, text: withNote(e.props.text, '⏳ PLaMo 翻訳中…') } })
    }
    // A draft of the response still streaming waits for turn.step. Any other text (an earlier reply,
    // one the step's blocks did not match) is queued from here.
    if (!isResponding && !queue.includes(text)) {
      $.ui.log(`plamo-ja: translating a reply turn.step did not queue (${text.length} chars)`, { to: 'debug' })
      enqueue(text)
      void pump($, config)
    }
    return next({ ...e, props: { ...e.props, text: withNote(e.props.text, '⏳ PLaMo 翻訳中…') } })
  })
}
