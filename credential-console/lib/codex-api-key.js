/**
 * A Codex account can hold an OpenAI platform API key instead of pointing at a
 * ChatGPT credential home. Such an account is billed per token on the OpenAI
 * platform rather than against a ChatGPT plan, and its requests go to the
 * public Responses API, not to chatgpt.com.
 *
 * The key itself is stored encrypted under `credential.api_key`, like a Bedrock
 * key; `codex_auth` is the readable marker that says which kind of Codex row
 * this is, so pages and the proxy can tell without decrypting anything.
 */
export const CODEX_API_KEY_AUTH = 'api-key';
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

/**
 * What a device is told when the guard on an API-key account refuses a model.
 * On such an account the guard has no quota reading to wait for: it stays on
 * for as long as it is switched on, because every token costs money.
 */
export const API_KEY_GUARD_MESSAGE = 'this Codex account is billed per token through an OpenAI API key; '
  + 'only "luna" models are allowed on it '
  + '(该账号走 OpenAI API key 按 token 计费，仅允许含 luna 的模型)';

export function isCodexApiKeyAccount(account) {
  return account?.provider === 'codex' && account?.codex_auth === CODEX_API_KEY_AUTH;
}

/** Whether a Codex row has something the gateway can forward requests with. */
export function isCodexGatewayAccount(account) {
  return account?.provider === 'codex'
    && (account.external?.kind === 'codex-credential' || isCodexApiKeyAccount(account));
}
