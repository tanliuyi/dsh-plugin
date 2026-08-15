/**
 * 内容扫描器 — 阻止记忆写入中的注入/外泄。
 * 移植自 hermes-agent/tools/memory_tool.py（_MEMORY_THREAT_PATTERNS、
 * _INVISIBLE_CHARS、_scan_memory_content）。
 */

const MEMORY_THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /you\s+are\s+now\s+/i, id: 'role_hijack' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: 'bypass_restrictions' },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_curl' },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_wget' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: 'read_secrets' },
  { pattern: /authorized_keys/i, id: 'ssh_backdoor' },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: 'ssh_access' },
]

/**
 * 机密检测模式 — 检查绝不应持久化到记忆的凭据、API key、token 与环境变量泄漏。
 * 移植自 pk-pi-hermes-evolve 的 engine.ts scanForSecrets()。
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; id: string; severity: 'high' | 'medium' }> = [
  // API keys
  { pattern: /\bsk-ant-api\S{10,}\b/, id: 'anthropic_api_key', severity: 'high' },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: 'openrouter_api_key', severity: 'high' },
  { pattern: /\bsk-\S{20,}\b/, id: 'openai_api_key', severity: 'high' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: 'aws_access_key', severity: 'high' },
  // Tokens
  { pattern: /\bghp_\S{10,}\b/, id: 'github_personal_token', severity: 'high' },
  { pattern: /\bghu_\S{10,}\b/, id: 'github_user_token', severity: 'high' },
  { pattern: /\bxoxb-\S{10,}\b/, id: 'slack_bot_token', severity: 'high' },
  { pattern: /\bxapp-\S{10,}\b/, id: 'slack_app_token', severity: 'high' },
  { pattern: /\bntn_\S{10,}\b/, id: 'notion_token', severity: 'high' },
  { pattern: /\bBearer\s+\S{20,}\b/, id: 'bearer_auth_token', severity: 'high' },
  // SSH keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: 'private_key_block', severity: 'high' },
  // 指示机密的变量名
  { pattern: /\bANTHROPIC_API_KEY\b/, id: 'env_anthropic_key', severity: 'medium' },
  { pattern: /\bOPENAI_API_KEY\b/, id: 'env_openai_key', severity: 'medium' },
  { pattern: /\bOPENROUTER_API_KEY\b/, id: 'env_openrouter_key', severity: 'medium' },
  { pattern: /\bGITHUB_TOKEN\b/, id: 'env_github_token', severity: 'medium' },
  { pattern: /\bAWS_SECRET_ACCESS_KEY\b/, id: 'env_aws_secret', severity: 'medium' },
  { pattern: /\bDATABASE_URL\b/, id: 'env_database_url', severity: 'medium' },
  // 内联机密赋值（可能是误粘贴）
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: 'password_assignment', severity: 'medium' },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: 'secret_assignment', severity: 'medium' },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: 'token_assignment', severity: 'medium' },
]

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
])

/**
 * 扫描记忆内容中的注入/外泄模式与机密泄漏。
 * @param content - 待扫描内容
 * @returns 被阻止时返回错误字符串，安全时返回 null
 */
export function scanContent(content: string): string | null {
  // 检查不可见 unicode
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (possible injection).`
    }
  }

  // 检查威胁模式
  for (const { pattern, id } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${id}'. Memory entries may be surfaced through search or legacy prompt injection and must not contain injection or exfiltration payloads.`
    }
  }

  // 检查机密模式
  for (const { pattern, id, severity } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content looks like a ${severity}-severity credential or secret ('${id}'). Never persist API keys, tokens, or passwords to memory. Use an .env file or secrets manager instead.`
    }
  }

  return null
}

/**
 * 只扫描机密（不含威胁模式）。
 * @param content - 待扫描内容
 * @returns 命中的机密 id 列表；无命中时为空数组
 */
export function scanSecrets(content: string): string[] {
  const found: string[] = []
  for (const { pattern, id } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      found.push(id)
    }
  }
  return found
}
