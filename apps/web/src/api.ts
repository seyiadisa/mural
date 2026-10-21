export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers
  } });
  if (!response.ok) {
    let code = 'request_failed';
    try { const result = await response.json() as { error?: { code?: string } }; code = result.error?.code ?? code; } catch { /* Response has no JSON error envelope. */ }
    throw new Error(code);
  }
  return response.json() as Promise<T>;
}

export function explainError(code: string): string {
  const messages: Record<string, string> = {
    web_auth_not_configured: 'Add the owner email and Google web client ID to the server configuration.',
    web_owner_not_configured: 'Add MURAL_WEB_OWNER_EMAIL to the server configuration.',
    owner_access_required: 'This Google account is not on the owner allowlist.',
    accounts_proxy_not_ready: 'The trusted proxy is not configured for account sign-in.',
    web_secrets_not_configured: 'Set a 32-byte MURAL_SECRETS_ENCRYPTION_KEY on the server to store provider credentials.',
    siwc_not_connected: 'Connect your ChatGPT plan from the server with the SIWC setup steps in Settings.',
    siwc_reconnect_required: 'Your ChatGPT connection expired. Reconnect it from the server.',
    siwc_plan_access_missing: 'This ChatGPT sign-in did not include plan access for Responses requests.',
    compatible_provider_key_missing: 'Add an API key for the selected compatible provider.',
    ai_provider_auth_failed: 'The selected provider rejected its credential. Check Settings.',
    ai_provider_rate_limited: 'The selected provider is temporarily rate limited.',
    ai_provider_unavailable: 'The selected AI provider could not be reached.',
    ai_provider_incomplete: 'The provider ended before completing its response. Try again.',
    voice_provider_not_configured: 'Voice is paused until an OpenAI API key is configured on the server.',
    hosted_voice_not_ready: 'Voice is not available right now. Typed practice still works.',
    voice_monthly_budget_reached: 'The $10 voice allowance is used or reserved for this UTC month.',
    live_session_unresolved: 'The previous voice session is still closing. Try again in a moment.',
    invalid_origin: 'This request came from an unexpected website origin.'
  };
  return messages[code] ?? 'Something went wrong. Please try again.';
}
