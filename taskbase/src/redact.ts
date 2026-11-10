/** 仅用于诊断文字；不改写业务输入、正文或检查点。 */
const REDACTED = '[REDACTED]';
const SECRET_KEY = '(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|signature|credential|[a-z][a-z0-9_-]*(?:password|token|secret|api[_-]?key))';
const jsonSecret = new RegExp(`("${SECRET_KEY}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi');
const assignment = new RegExp(`(\\b${SECRET_KEY}\\b\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s;,}]+)`, 'gi');

export function redactText(message: string): string {
  let safe = message.replace(/https?:\/\/[^\s<>"'`\\]+/gi, (value) => {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch { return '[URL REDACTED]'; }
  });
  safe = safe.replace(jsonSecret, `$1"${REDACTED}"`)
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, `Cookie: ${REDACTED}`)
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
    .replace(assignment, `$1${REDACTED}`);
  // 外部工具可能只输出密钥值而没有字段名；仅匹配明确命名的环境秘密。
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|COOKIE)(?:$|_)/i.test(name) && secret && secret.length >= 4) {
      safe = safe.split(secret).join(REDACTED);
    }
  }
  return safe;
}

export function diagnosticMessage(error: unknown, maxLength = 1000): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, maxLength);
}
