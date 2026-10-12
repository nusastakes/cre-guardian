// LLM side of the guardian: builds the request for either provider and parses the reply.
// Both providers speak the Anthropic Messages format, so one request shape serves both:
//   - anthropic: https://api.anthropic.com/v1/messages  (x-api-key + anthropic-version)
//   - xkiro:     https://api.xkiro.com/v1/messages      (an Anthropic- and OpenAI-compatible gateway)
// The workflow runs this code in the CRE sandbox, which has no Node APIs, so it only uses plain JSON and fetch-like
// capabilities provided by the SDK.

import { z } from 'zod'
import type { RiskLevel } from './risk'

export const llmConfigSchema = z.object({
  provider: z.enum(['anthropic', 'xkiro', 'none']),
  /** Model id as the provider spells it. For Anthropic: claude-sonnet-5-5. For xKiro: the id from GET /v1/models. */
  model: z.string(),
  baseUrl: z.string().optional(),
  /** Output budget. Leave room: a model that thinks first spends part of it before the JSON answer starts. */
  maxTokens: z.number().int().min(50).max(4000).default(600),
})
export type LlmConfig = z.infer<typeof llmConfigSchema>

export const llmReplySchema = z.object({
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  reason: z.string().min(1).max(400),
})
export type LlmReply = { risk: RiskLevel; reason: string }

export const SYSTEM_PROMPT = [
  'You are the risk officer ("satpam") of Nusastakes, a game where each city is an on-chain vault that a mayor invests',
  'in real DeFi protocols. Residents can only be protected in one way: pulling a city\'s funds back to idle cash.',
  'You will receive a JSON snapshot of cities and of the off-chain source vault their yield is mirrored from.',
  'Classify the overall risk as LOW, MEDIUM or HIGH and explain it in one or two plain sentences. Each city carries a',
  '"ruleRisk" from a deterministic engine: treat it as input, form your own judgement from the data, and make "risk"',
  'agree with the reason you give (if your reason finds no concrete loss, the risk is not HIGH).',
  'Rules: use HIGH only when the data shows a concrete loss, a red warning, or a collapse; never invent facts that are',
  'not in the snapshot; missing data is not a reason for HIGH.',
  'Reply with ONLY a JSON object: {"risk":"LOW|MEDIUM|HIGH","reason":"..."} and nothing else.',
].join(' ')

export function defaultBaseUrl(provider: 'anthropic' | 'xkiro'): string {
  return provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.xkiro.com/v1'
}

export interface LlmHttpRequest {
  url: string
  headers: Record<string, string>
  /** JSON text of the request body. */
  body: string
}

export function buildLlmRequest(cfg: LlmConfig, apiKey: string, snapshot: unknown): LlmHttpRequest {
  if (cfg.provider === 'none') throw new Error('LLM provider is "none"')
  const base = (cfg.baseUrl ?? defaultBaseUrl(cfg.provider)).replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.provider === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    // xKiro documents both Authorization and x-api-key; send both so either gateway route accepts the key.
    headers['authorization'] = `Bearer ${apiKey}`
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    // Claude Sonnet 5.5 thinks by default (about 300 tokens here, which cut the JSON answer off at max_tokens 300 and
    // added seconds against the 10 s limit on HTTP calls). A one-line verdict does not need it. xKiro accepts either form.
    ...(cfg.provider === 'anthropic' ? { thinking: { type: 'between_tools' } } : {}),
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(snapshot) }],
  })
  return { url: `${base}/messages`, headers, body }
}

/** Pulls the text out of an Anthropic-format reply. */
export function replyText(payload: unknown): string | null {
  const content = (payload as { content?: { type?: string; text?: string }[] } | null)?.content
  if (!Array.isArray(content)) return null
  const parts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text as string)
  return parts.length ? parts.join('\n') : null
}

/** Finds the first JSON object in the model's text and validates it. Returns null if it is not what we asked for. */
export function parseLlmReply(text: string | null): LlmReply | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = llmReplySchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
