const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|bearer|private[_-]?key|secret|credential)/i;

export function redactText(value) {
  return String(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key redacted]")
    .replace(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[credential redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[credential redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[credential redacted]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(--?(?:token|password|secret|api[-_]?key|access[-_]?token|client[-_]?secret))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1 [redacted]")
    .replace(/(["']?\b(?:OPENAI_)?(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PASSWD|AUTHORIZATION|BEARER[_-]?TOKEN|GITHUB[_-]?TOKEN|AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY)\b["']?\s*[:=]\s*["']?)[^\s"',;}{]+/gi, "$1[redacted]")
    .slice(0, 50000);
}

export function redactMcpResult(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(item => redactMcpResult(item, depth + 1));
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redactMcpResult(item, depth + 1)]));
}
