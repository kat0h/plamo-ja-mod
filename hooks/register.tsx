import type { EngineInterface, Register } from 'claude-code'

type Config = { endpoint: string; model: string; form: string }

const CONTEXT =
  'The user reads every reply through a local English-to-Japanese machine translator (PLaMo), ' +
  'so replies in this session are written in English, even when the user writes in Japanese.'

const cache = new Map<string, string>() // English text -> Japanese
const failed = new Map<string, string>() // English text -> reason; cleared on the next prompt so it is retried
// requestId -> newest text. A streaming reply overwrites its entry, so only the latest draft is translated.
const wanted = new Map<string, string>()
let isBusy = false

function pfml3(text: string, form: string): string {
  return (
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    `<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${text.replaceAll('<|plamo:', '<|plamo :')}` +
    `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>${form}<|plamo:msg|>`
  )
}

async function translate($: EngineInterface, config: Config, text: string): Promise<string> {
  // The GGUF build's bundled chat template ignores chat_template_kwargs, so the PFML3 prompt goes to the Completions API as is.
  const res = await $.http.fetch(`${config.endpoint.replace(/\/+$/, '')}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt: pfml3(text, config.form),
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
      const [text] = pending()
      if (text === undefined) break
      $.ui.status(`PLaMo 翻訳中 (残り ${pending().length} 件)`)
      try {
        cache.set(text, await translate($, config, text))
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

export const register: Register = (on, options) => {
  const config: Config = {
    endpoint: String(options.endpoint),
    model: String(options.model),
    form: String(options.form),
  }

  on('prompt.submit', ($, e, next) => {
    if (e.command) return next(e)
    if (failed.size > 0) {
      failed.clear()
      $.ui.invalidate('ui.render')
    }
    return next({ ...e, context: [...(e.context ?? []), CONTEXT] })
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.props.isSummary) return next(e)
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
