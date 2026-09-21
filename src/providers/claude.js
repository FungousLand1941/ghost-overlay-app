const Anthropic = require('@anthropic-ai/sdk');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function toClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const content = [];
    if (m.image?.data) {
      content.push({ type: 'image', source: { type: 'base64', media_type: m.image.mime || 'image/jpeg', data: m.image.data } });
    }
    content.push({ type: 'text', text: m.text || (m.image ? 'Here is my screen.' : '') });
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    // Anthropic requires alternating roles; merge consecutive same-role turns.
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] });
  return out;
}

async function* stream({ cfg, apiKey, messages, system, signal }) {
  const c = cfg.claude || {};
  // Keys created at the organization level (not inside a workspace) must name
  // the workspace to bill/scope to; the Console shows it as wrkspc_… under Settings → Workspaces.
  const defaultHeaders = c.workspaceId ? { 'anthropic-workspace-id': String(c.workspaceId).trim() } : undefined;
  const client = new Anthropic({ apiKey, maxRetries: 1, defaultHeaders });
  const params = {
    model: c.model || 'claude-opus-5',
    max_tokens: cfg.maxTokens || 4096,
    // The system prompt is identical across a session (profile + background
    // context), so cache it: cheaper and a faster first token on every turn.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: toClaudeMessages(messages),
  };
  // Haiku 4.5 still uses the older thinking API and rejects effort; skip both there.
  if (!/haiku/i.test(params.model)) {
    const speed = cfg.speed || 'fast';
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: speed === 'fast' ? 'low' : speed === 'balanced' ? 'medium' : (c.effort || 'high') };
  }

  // Server-side refusal fallback: if the primary model declines on policy,
  // the API re-runs the request on a fallback model inside the same call.
  // Configurable (cfg.claude.fallbacks); we retry without it if the account
  // or proxy rejects the beta.
  const useFallback = c.fallbacks !== false;
  const run = (withFallback) => withFallback
    ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
    : client.messages.stream(params, { signal });

  let s;
  try {
    s = run(useFallback);
    yield* consume(s);
  } catch (err) {
    if (useFallback && err instanceof Anthropic.BadRequestError && /fallback/i.test(String(err.message))) {
      s = run(false);
      yield* consume(s);
      return;
    }
    // Multi-workspace key without a workspace header: try to find the workspace
    // ourselves, persist it, and retry once.
    if (!c.workspaceId && /not scoped to a workspace/i.test(String(err.message))) {
      const id = await discoverWorkspace(apiKey);
      if (id) {
        try { module.exports.onWorkspaceDiscovered?.(id); } catch {}
        const client2 = new Anthropic({ apiKey, maxRetries: 1, defaultHeaders: { 'anthropic-workspace-id': id } });
        s = useFallback ? client2.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal }) : client2.messages.stream(params, { signal });
        yield* consume(s);
        return;
      }
    }
    throw normalize(err);
  }
}

// Find a workspace this key can use: (1) any workspace-agnostic endpoint returns
// the resolved workspace in a response header; (2) multi-workspace personal keys
// may list the organization's workspaces via the Admin API.
async function discoverWorkspace(apiKey) {
  const H = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: H });
    const id = r.headers.get('anthropic-workspace-id');
    if (r.ok && id) return id;
  } catch {}
  try {
    const r = await fetch('https://api.anthropic.com/v1/organizations/workspaces?limit=20&include_archived=false', { headers: H });
    if (r.ok) {
      const j = await r.json();
      const ws = (j.data || []).filter((w) => !w.archived_at);
      if (ws.length) return ws[0].id;
    }
  } catch {}
  return null;
}

async function* consume(s) {
  for await (const ev of s) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
  }
  const final = await s.finalMessage();
  if (final.stop_reason === 'refusal') {
    const why = final.stop_details?.explanation ? ` (${final.stop_details.explanation})` : '';
    yield `\n\n_[The model declined this request${why}.]_`;
  } else if (final.stop_reason === 'max_tokens') {
    yield '\n\n_[Cut off at max tokens — raise "Max tokens" in settings.]_';
  }
}

function normalize(err) {
  if (/not scoped to a workspace/i.test(String(err && err.message))) return new Error('Claude: this key works across workspaces, so Anthropic needs to know which one — and Ghost could not detect it automatically. Easiest fix: in the Console go to API keys → Create Key and pick a workspace (e.g. Default) in the dialog; that key needs nothing extra. Or paste a workspace ID (wrkspc_…, Settings → Workspaces → open the workspace) into ⚙ → Claude → Workspace ID.');
  if (err instanceof Anthropic.AuthenticationError) return new Error('Claude: invalid API key.');
  if (/credit balance|billing/i.test(String(err && err.message))) return new Error(`Claude: ${err.message.replace(/^\d+\s*/, '')} — add credit at console.anthropic.com → Billing.`);
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude: rate limited — try again in a moment.');
  if (err instanceof Anthropic.NotFoundError) return new Error(`Claude: model not found (${err.message}).`);
  if (err instanceof Anthropic.APIConnectionError) return new Error('Claude: network error.');
  if (err instanceof Anthropic.APIError) return new Error(`Claude ${err.status}: ${err.message}`);
  return err;
}

module.exports = { stream, discoverWorkspace, onWorkspaceDiscovered: null };
