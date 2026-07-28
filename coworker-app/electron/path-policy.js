import path from "node:path";

const SENSITIVE_NAMES = new Set([".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "secrets.json"]);

export function isSensitivePath(input) {
  const parts = String(input || "").split(/[\\/]+/).filter(Boolean);
  return parts.some(part => {
    const name = part.toLowerCase();
    return name === ".git" || name === ".ssh" || name === ".env" || name.startsWith(".env.") || SENSITIVE_NAMES.has(name) ||
      /^id_(rsa|ed25519)(\.|$)/.test(name) || /\.(pem|key|p12|pfx|kdbx)$/.test(name) || /(^|[._-])(secret|credential|private-key)([._-]|$)/.test(name);
  });
}

export function relativeWorkspacePath(root, target) {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}
