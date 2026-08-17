// One release stamp for every generated Claude/Codex client profile.
//
// Client installers receive this value from the console at generation time;
// the client-agent source must not define a second authority for it.
export const CLIENT_CONFIG_VERSION = '1';
export const CLAUDE_CLIENT_CONFIG_VERSION_KEY = 'CREDENTIAL_CONSOLE_CLIENT_CONFIG_VERSION';
export const CODEX_UNIX_CLIENT_CONFIG_VERSION_FILE = '.config/claude-codex-gateway/client-agent/config-version';
export const CODEX_WINDOWS_CLIENT_CONFIG_VERSION_FILE = 'claude-codex-gateway\\client-agent\\config-version';
