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

function prompts(on: On) {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  return sent
}

const typed = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

async function userShown($: Engine, text: string) {
  const ui = await $.ui.mount({
    plugin: 'plamo-ja',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text, origin: { kind: 'composer' }, isExpanded: true },
  })
  const found = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return found
}

test('on-input sends the prompt in English and shows it as typed', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const sent = prompts(on)
  const bodies: string[] = []
  on('http.fetch', (_, e) => {
    bodies.push(JSON.parse(String(e.init?.body)).prompt)
    return reply(' Please fix the test. ')
  })
  await plamo($, 'on-input')

  await typed($, 'テストを直してください。')
  expect(sent).toEqual(['Please fix the test.'])
  expect(bodies[0]).toContain('<|plamo:val|>ja<|plamo:msg|>テストを直してください。')
  expect(bodies[0]!.endsWith('<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>')).toBe(true)
  expect(await userShown($, 'Please fix the test.')).toBe('テストを直してください。')

  // Back to plain on: the prompt shows as it was sent.
  await plamo($, 'on')
  expect(await userShown($, 'Please fix the test.')).toBe('Please fix the test.')
  await plamo($, 'off')
})

test('plain on sends the prompt as typed', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const sent = prompts(on)
  let calls = 0
  on('http.fetch', () => {
    calls++
    return reply('x')
  })
  await plamo($, 'on')

  await typed($, 'そのまま送ってください。')
  expect(sent).toEqual(['そのまま送ってください。'])
  expect(calls).toBe(0)
  await plamo($, 'off')
})

test('on-input sends the Japanese when the server fails', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('ui.toast', () => ({ value: undefined }))
  const sent = prompts(on)
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  await plamo($, 'on-input')

  await typed($, '失敗しても送ってください。')
  expect(sent).toEqual(['失敗しても送ってください。'])
  await plamo($, 'off')
})


function response(on: On, blocks: string[]) {
  on('turn.step', async function* (_, e) {
    for (const [index, text] of blocks.entries()) {
      // each block arrives in two pieces, as a streamed reply does
      yield { kind: 'text', index, text: text.slice(0, 5) }
      yield { kind: 'text', index, text: text.slice(5) }
    }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: blocks.join(''), toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

const STEP = { turnId: 't1', index: 0, model: 'm', messageCount: 1 }

test('a reply is translated once its response is whole, not while it streams', { options: OPTIONS }, async ($, on) => {
  engine(on)
  response(on, ['First block here.', 'Second block here.'])
  const bodies: Record<string, unknown>[] = []
  on('http.fetch', (_, e) => {
    bodies.push(JSON.parse(String(e.init?.body)))
    return reply(bodies.length === 1 ? '一つ目のブロック。' : '二つ目のブロック。')
  })
  await plamo($, 'on')

  const stream = $.turn.step(STEP)
  const chunks: unknown[] = []
  const first = await stream.next()
  chunks.push(first.value)
  // A draft drawn mid-response waits, untranslated.
  expect(await shown($, 's1', 'First')).toContain('⏳ PLaMo 翻訳中')
  expect(bodies.length).toBe(0)

  for (;;) {
    const step = await stream.next()
    if (step.done) {
      expect(step.value.answer).toBe('First block here.Second block here.')
      break
    }
    chunks.push(step.value)
  }
  // Every chunk passes through unchanged.
  expect(chunks.length).toBe(5)

  expect(await shown($, 's1', 'First block here.')).toBe('一つ目のブロック。')
  expect(await shown($, 's2', 'Second block here.')).toBe('二つ目のブロック。')
  expect(bodies.length).toBe(2)
  expect(String(bodies[0]!.prompt)).toContain('First block here.<|plamo:tag|>output')
  expect(bodies[0]!.cache_prompt).toBe(true)
  expect(bodies[0]!.id_slot).toBe(0)
  await plamo($, 'off')
})

test('a subagent response is not queued', { options: OPTIONS }, async ($, on) => {
  engine(on)
  response(on, ['Subagent words here.'])
  let calls = 0
  on('http.fetch', () => {
    calls++
    return reply('x')
  })
  await plamo($, 'on')

  const stream = $.turn.step({ ...STEP, agentId: 'a1' })
  while (!(await stream.next()).done) {}
  expect(calls).toBe(0)
  await plamo($, 'off')
})


test('a reply off screen waits until it is scrolled into view', { options: OPTIONS }, async ($, on) => {
  engine(on)
  let calls = 0
  on('http.fetch', () => {
    calls++
    return reply('見えたら訳します。')
  })
  await plamo($, 'on')

  const at = (onScreen: { first: number; last: number; of: number } | null) =>
    $.ui.mount({ ...MESSAGE, requestId: 'v1', props: { ...MESSAGE.props, text: 'Translate me when shown.', onScreen } })

  let ui = await at(null)
  expect((await ui.find({ type: 'Text' }))?.text).toContain('⏳ PLaMo 翻訳中')
  expect(calls).toBe(0)
  await ui.unmount()

  ui = await at({ first: 0, last: 3, of: 4 })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('見えたら訳します。')
  expect(calls).toBe(1)
  await ui.unmount()
  await plamo($, 'off')
})


function contexts(on: On) {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text }
  })
  return seen
}

test('/plamo answers alone; the instruction rides on the next prompt, once', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const seen = contexts(on)
  on('http.fetch', () => reply('Hello.'))

  const result = await plamo($, 'on')
  expect(result.text).toContain('オン')
  expect(result.context).toBeUndefined()

  await typed($, 'first')
  await typed($, 'second')
  expect(seen[0]?.[0]).toContain('write all user-facing text in English')
  expect(seen[1]).toBeUndefined()

  await plamo($, 'on-input')
  await typed($, 'third')
  expect(seen[2]?.[0]).toContain('machine-translated from Japanese into English')

  await plamo($, 'off')
  await typed($, 'fourth')
  expect(seen[3]?.[0]).toContain('Reply in Japanese again')

  expect((await plamo($, 'what')).text).toContain('使い方')
})

test('off before any prompt sends nothing', { options: OPTIONS }, async ($, on) => {
  engine(on)
  const seen = contexts(on)
  await plamo($, 'off') // Claude was told "off" by the test above; start from that
  await typed($, 'a')
  await plamo($, 'on')
  await plamo($, 'off')
  await typed($, 'b')
  // told off already: switching on and off again before a prompt says nothing more
  expect(seen.at(-1)).toBeUndefined()
})

// Last: its fetch never answers, which keeps the module's queue busy for any test after it.
test('a reply shows the translating note while the server answers', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('http.fetch', () => new Promise(() => {}))
  await plamo($, 'on')

  expect(await shown($, 'm0', 'Wait.')).toContain('⏳ PLaMo 翻訳中')
})
