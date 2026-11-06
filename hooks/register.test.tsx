import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const MESSAGE = {
  plugin: 'plamo-ja',
  surface: 'desktop',
  component: 'AssistantMessage',
  requestId: 'm1',
  props: { text: 'Hello.', isFirstOfReply: true },
} as const

const OPTIONS = { endpoint: 'http://127.0.0.1:9/v1', model: 'm', form: 'polite' }

function engine(on: On) {
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'plamo' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

function reply(text: string) {
  return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ text }] }) } }
}

const plamo = ($: Engine, args: string) =>
  $.command.run({ command: 'plamo', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

async function shown($: Engine, requestId: string, text: string) {
  const ui = await $.ui.mount({ ...MESSAGE, requestId, props: { ...MESSAGE.props, text } })
  const found = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return found
}

test('nothing is translated until /plamo on', { options: OPTIONS }, async ($, on) => {
  engine(on)
  let calls = 0
  on('http.fetch', () => {
    calls++
    return reply('訳')
  })
  await plamo($, 'off')

  expect(await shown($, 'off1', 'Not yet.')).toBe('Not yet.')
  expect(calls).toBe(0)
})

test('/plamo on and off send the language instruction once', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const onResult = await plamo($, 'on')
  expect(onResult.text).toContain('オン')
  expect(onResult.context?.[0]).toContain('write all user-facing text in English')

  const offResult = await plamo($, 'off')
  expect(offResult.text).toContain('オフ')
  expect(offResult.context?.[0]).toContain('Reply in Japanese again')

  expect((await plamo($, 'what')).text).toContain('使い方')
})

test('a reply is replaced by its translation', { options: OPTIONS }, async ($, on) => {
  const urls: string[] = []
  engine(on)
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    return reply(' こんにちは。 ')
  })
  await plamo($, 'on')

  expect(await shown($, 'm1', 'Hello.')).toBe('こんにちは。')
  expect(urls).toEqual(['http://127.0.0.1:9/v1/completions'])
})

test('off shows the English again, and on reuses the translation', { options: OPTIONS }, async ($, on) => {
  engine(on)
  let calls = 0
  on('http.fetch', () => {
    calls++
    return reply('眼鏡です。')
  })
  await plamo($, 'on')
  expect(await shown($, 'g1', 'These are glasses.')).toBe('眼鏡です。')

  await plamo($, 'off')
  expect(await shown($, 'g1', 'These are glasses.')).toBe('These are glasses.')

  await plamo($, 'on')
  expect(await shown($, 'g1', 'These are glasses.')).toBe('眼鏡です。')
  expect(calls).toBe(1)
})

test('earlier translations are sent as context', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const prompts: string[] = []
  on('http.fetch', (_, e) => {
    prompts.push(JSON.parse(String(e.init?.body)).prompt)
    return reply(prompts.length === 1 ? '一つ目です。' : '二つ目です。')
  })
  await plamo($, 'on')

  await shown($, 'c1', 'This is the first.')
  await shown($, 'c2', 'This is the second.')
  const prompt = prompts.at(-1)!
  expect(prompt).toContain('<|plamo:tag|>context<|plamo:msg|>')
  expect(prompt).toContain('<|plamo:msg|>This is the first.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>一つ目です。')
  expect(prompt.endsWith('This is the second.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>')).toBe(true)
})

test('a Japanese reply is shown as is', { options: OPTIONS }, async ($, on) => {
  engine(on)
  let calls = 0
  on('http.fetch', () => {
    calls++
    return reply('x')
  })
  await plamo($, 'on')

  expect(await shown($, 'j1', 'これは日本語の応答です。')).toBe('これは日本語の応答です。')
  expect(calls).toBe(0)
})

test('a failed translation shows the reason', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  await plamo($, 'on')

  expect(await shown($, 'm2', 'Bye.')).toContain('⚠ PLaMo 翻訳に失敗しました (HTTP 500)')
})

const QUESTIONS = [
  {
    question: 'Which name?',
    header: 'Name',
    multiSelect: false,
    options: [
      { label: 'Short one', description: 'A short name.' },
      { label: 'Long one', description: 'A long name.' },
    ],
  },
]

const JA: Record<string, string> = {
  'Which name?': 'どの名前？',
  Name: '名前',
  'Short one': '短い方',
  'Long one': '長い方',
  'A short name.': '短い名前。',
  'A long name.': '長い名前。',
}

function sourceOf(prompt: string): string {
  return prompt.match(/en<\|plamo:msg\|>(.*?)<\|plamo:tag\|>output[^]*$/)![1]!
}

test('AskUserQuestion is translated before it is shown', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const seen: unknown[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: {} }
  })
  on('http.fetch', (_, e) => reply(JA[sourceOf(JSON.parse(String(e.init?.body)).prompt)] ?? '?'))
  await plamo($, 'on')

  await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  const q = (seen[0] as { questions: typeof QUESTIONS }).questions[0]!
  expect(q.question).toBe('どの名前？')
  expect(q.header).toBe('名前')
  expect(q.options.map(o => o.label)).toEqual(['短い方', '長い方'])
  expect(q.options.map(o => o.description)).toEqual(['短い名前。', '長い名前。'])
})

test('AskUserQuestion stays in English when the server fails', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const seen: unknown[] = []
  on('tool.call', (_, e) => {
    seen.push(e)
    return { result: {} }
  })
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  await plamo($, 'on')

  const questions = [{ ...QUESTIONS[0]!, question: 'Which color?', header: 'Color' }]
  await $.tool.call({ tool: 'AskUserQuestion', questions })
  const q = (seen[0] as { questions: typeof QUESTIONS }).questions[0]!
  expect(q.question).toBe('Which color?')
})

// Last: its fetch never answers, which keeps the module's queue busy for any test after it.
test('a reply shows the translating note while the server answers', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('http.fetch', () => new Promise(() => {}))
  await plamo($, 'on')

  expect(await shown($, 'm0', 'Wait.')).toContain('⏳ PLaMo 翻訳中')
})
