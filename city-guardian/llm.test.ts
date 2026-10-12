import { describe, expect, test } from 'bun:test'
import { buildLlmRequest, defaultBaseUrl, parseLlmReply, replyText, SYSTEM_PROMPT, type LlmConfig } from './llm'

const anthropic: LlmConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', maxTokens: 300 }
const xkiro: LlmConfig = { provider: 'xkiro', model: 'anthropic/claude-sonnet-5-5', maxTokens: 300 }

describe('buildLlmRequest', () => {
  test('anthropic: official endpoint, x-api-key and version header, model and snapshot in the body', () => {
    const r = buildLlmRequest(anthropic, 'sk-test', { cities: [] })
    expect(r.url).toBe('https://api.anthropic.com/v1/messages')
    expect(r.headers['x-api-key']).toBe('sk-test')
    expect(r.headers['anthropic-version']).toBe('2023-06-01')
    expect(r.headers['authorization']).toBeUndefined()
    const body = JSON.parse(r.body)
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.max_tokens).toBe(300)
    expect(body.system).toBe(SYSTEM_PROMPT)
    expect(body.messages[0]).toEqual({ role: 'user', content: JSON.stringify({ cities: [] }) })
  })
  test('xkiro: gateway endpoint, accepts the key as Bearer and as x-api-key', () => {
    const r = buildLlmRequest(xkiro, 'k', {})
    expect(r.url).toBe('https://api.xkiro.com/v1/messages')
    expect(r.headers['authorization']).toBe('Bearer k')
    expect(r.headers['x-api-key']).toBe('k')
    expect(JSON.parse(r.body).model).toBe('anthropic/claude-sonnet-5-5')
  })
  test('a custom base URL wins and a trailing slash is tolerated', () => {
    expect(buildLlmRequest({ ...anthropic, baseUrl: 'https://proxy.example/v1/' }, 'k', {}).url).toBe('https://proxy.example/v1/messages')
  })
  test('provider "none" cannot build a request', () => {
    expect(() => buildLlmRequest({ provider: 'none', model: 'x', maxTokens: 100 }, 'k', {})).toThrow()
  })
  test('the secret never appears in the body', () => {
    expect(buildLlmRequest(anthropic, 'sk-very-secret', { a: 1 }).body).not.toContain('sk-very-secret')
  })
  test('default base URLs', () => {
    expect(defaultBaseUrl('anthropic')).toBe('https://api.anthropic.com/v1')
    expect(defaultBaseUrl('xkiro')).toBe('https://api.xkiro.com/v1')
  })
})

describe('reply parsing', () => {
  const wrap = (text: string) => ({ content: [{ type: 'text', text }] })
  test('reads the text block of an Anthropic reply', () => {
    expect(replyText(wrap('hello'))).toBe('hello')
    expect(replyText({ content: [{ type: 'tool_use' }] })).toBeNull()
    expect(replyText(null)).toBeNull()
    expect(replyText({})).toBeNull()
  })
  test('accepts a clean JSON reply', () => {
    expect(parseLlmReply('{"risk":"HIGH","reason":"price collapsed"}')).toEqual({ risk: 'HIGH', reason: 'price collapsed' })
  })
  test('accepts JSON wrapped in prose or a code fence', () => {
    expect(parseLlmReply('Here you go:\n```json\n{"risk":"LOW","reason":"all calm"}\n```')?.risk).toBe('LOW')
  })
  test('rejects replies that are not what was asked for', () => {
    expect(parseLlmReply(null)).toBeNull()
    expect(parseLlmReply('no json here')).toBeNull()
    expect(parseLlmReply('{"risk":"CRITICAL","reason":"x"}')).toBeNull()
    expect(parseLlmReply('{"risk":"HIGH"}')).toBeNull()
    expect(parseLlmReply('{"risk":"HIGH","reason":""}')).toBeNull()
    expect(parseLlmReply('{not json}')).toBeNull()
    expect(parseLlmReply('{"risk":"HIGH","reason":"' + 'x'.repeat(500) + '"}')).toBeNull()
  })
})
