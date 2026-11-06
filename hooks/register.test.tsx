import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
}

test('a reply shows the translating note while the server answers', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('http.fetch', () => new Promise(() => {}))

  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'm0', props: { ...MESSAGE.props, text: 'Wait.' } })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('⏳ PLaMo 翻訳中')
  await ui.unmount()
})

test('a reply is replaced by its translation', { options: OPTIONS }, async ($, on) => {
  const urls: string[] = []
  engine(on)
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ text: ' こんにちは。 ' }] }) } }
  })

  const ui = await $.ui.mount(MESSAGE)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('こんにちは。')
  expect(urls).toEqual(['http://127.0.0.1:9/v1/completions'])
  await ui.unmount()
})

test('a failed translation shows the reason', { options: OPTIONS }, async ($, on) => {
  engine(on)
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))

  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'm2', props: { ...MESSAGE.props, text: 'Bye.' } })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('⚠ PLaMo 翻訳に失敗しました (HTTP 500)')
  await ui.unmount()
})
