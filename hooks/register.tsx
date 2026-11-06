import type { EngineInterface, Register } from 'claude-code'

type Config = { endpoint: string; model: string; form: string }

// Sent once, as hidden context, when the person runs `/plamo on`.
const ENGLISH_ON =
  'Japanese display mode is on. The user reads every reply through a local English-to-Japanese machine ' +
  'translator (PLaMo), so from now on write all user-facing text in English, even when the user writes in ' +
  'Japanese. Do not write Japanese yourself. Use plain, complete sentences that translate well, and put code, ' +
  'commands and paths in backticks or fenced blocks. Write AskUserQuestion questions and options in English ' +
  'too; they are translated before they are shown. This lasts until the user turns the mode off.'
const ENGLISH_OFF = 'Japanese display mode is off. Reply in Japanese again, as before.'

// What PLaMo is told about the text it translates (the PFML3 context tag).
const TRANSLATION_CONTEXT =
  'Replies from an AI coding assistant (Claude Code) to a Japanese software ' +
  'developer in a terminal. Technical terms, file paths, commands and code stay as-is.'
const HISTORY_BUDGET = 8000 // max chars of earlier (English, Japanese) pairs sent as context

const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g
const ALPHA = /[A-Za-z]/g

let enabled = false
// English text -> Japanese. Insertion order is translation order, so it doubles as the context history.
const cache = new Map<string, string>()
const failed = new Map<string, string>() // English text -> reason; cleared on the next prompt so it is retried
// requestId -> newest text. A streaming reply overwrites its entry, so only the latest draft is translated.
const wanted = new Map<string, string>()
let historyStart = 0
let isBusy = false

function escape(text: string): string {
  return text.replaceAll('<|plamo:', '<|plamo :')
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

function pfml3(text: string, form: string, pairs: [string, string][]): string {
  let prompt = `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>context<|plamo:msg|>${TRANSLATION_CONTEXT}`
  for (const [en, ja] of pairs) {
    prompt +=
      `<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${escape(en)}` +
      `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>${escape(ja)}`
  }
  return (
    prompt +
    `<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${escape(text)}` +
    `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>${form}<|plamo:msg|>`
  )
}

async function translate(
  $: EngineInterface,
  config: Config,
  text: string,
  pairs: [string, string][] = [],
): Promise<string> {
  // The GGUF build's bundled chat template ignores chat_template_kwargs, so the PFML3 prompt goes to the Completions API as is.
  const res = await $.http.fetch(`${config.endpoint.replace(/\/+$/, '')}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt: pfml3(text, config.form, pairs),
      temperature: 0,
      max_tokens: 8192,
      stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const japanese: string = JSON.parse(res.text).choices[0].text.trim()
  if (!japanese) throw new Error('empty output')
  return japanese
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
  return [...wanted.values()].filter(t => !cache.has(t) && !failed.has(t))
}

function withNote(text: string, note: string): string {
  return `${text}\n\n---\n*${note}*`
}

async function pump($: EngineInterface, config: Config): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    for (;;) {
      if (!enabled) break
      const [text] = pending()
      if (text === undefined) break
      $.ui.status(`PLaMo 翻訳中 (残り ${pending().length} 件)`)
      try {
        const japanese = await translate($, config, text, history())
        cache.set(text, japanese)
      } catch (err) {
        failed.set(text, err instanceof Error ? err.message : String(err))
      }
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
      description: 'PLaMo で応答を日本語表示する (on / off)',
      argumentHint: '[on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'plamo' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '' || arg === 'on') {
      enabled = true
      $.ui.invalidate('ui.render')
      return { text: 'PLaMo 日本語表示: オン', context: [ENGLISH_ON] }
    }
    if (arg === 'off') {
      enabled = false
      $.ui.status(undefined)
      $.ui.invalidate('ui.render')
      return { text: 'PLaMo 日本語表示: オフ', context: [ENGLISH_OFF] }
    }
    return { text: '使い方: /plamo [on|off]' }
  })

  on('prompt.submit', ($, e, next) => {
    if (enabled && !e.command && failed.size > 0) {
      failed.clear()
      $.ui.invalidate('ui.render')
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold up the prompt over the retry bookkeeping

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!enabled) return next(e)
    $.ui.status('PLaMo 翻訳中 (質問)')
    try {
      const questions = await Promise.all(e.questions.map(q => translateQuestion($, config, q)))
      return next({ ...e, questions })
    } finally {
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => next(e)) // never block the question: show the English if translating throws

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!enabled || e.props.isSummary || isUntranslatable(e.props.text)) return next(e)
    const japanese = cache.get(e.props.text)
    if (japanese !== undefined) return next({ ...e, props: { ...e.props, text: japanese } })
    const reason = failed.get(e.props.text)
    if (reason !== undefined) {
      const note = `⚠ PLaMo 翻訳に失敗しました (${reason})。${config.endpoint} のサーバを確認してください。次のメッセージ送信時に再試行します`
      return next({ ...e, props: { ...e.props, text: withNote(e.props.text, note) } })
    }
    wanted.set(e.requestId, e.props.text)
    void pump($, config)
    return next({ ...e, props: { ...e.props, text: withNote(e.props.text, '⏳ PLaMo 翻訳中…') } })
  })
}
