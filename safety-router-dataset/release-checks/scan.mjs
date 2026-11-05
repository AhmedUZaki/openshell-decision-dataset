// Secret and machine-specific path scan used by dataset releases and by the source review before a first commit.
// A finding never prints the matched value (only the rule, the file, the line and the length), so the scan itself cannot leak a secret.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';

// Names that appear in documentation and test fixtures as placeholders, not as a real person's folder.
const PLACEHOLDER_NAMES = /^(someone|user|username|you|your-?name|name|example|me|public|default|all users|linuxbrew|sandbox|runner|\{.*\}|<.*>|%.*%|\$.*)$/i;

const SECRET_RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['api-key-sk', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['nvidia-api-key', /\bnvapi-[A-Za-z0-9_-]{20,}/],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ['credential-assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\w*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']{3,}@[^\s/"']+/i],
];

// Paths that tie content to one machine or user.
function pathFindings(line, names) {
  const out = [];
  for (const m of line.matchAll(/\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'<>|:*?]+)/g)) if (!PLACEHOLDER_NAMES.test(m[1])) out.push(['windows-user-path', m[0].length]);
  for (const m of line.matchAll(/\/mnt\/[a-z]\/Users\/([^/\s"']+)/g)) if (!PLACEHOLDER_NAMES.test(m[1])) out.push(['wsl-windows-user-path', m[0].length]);
  for (const m of line.matchAll(/(?<![A-Za-z0-9_.-])\/Users\/([A-Za-z0-9._-]+)/g)) if (!PLACEHOLDER_NAMES.test(m[1])) out.push(['macos-user-path', m[0].length]);
  for (const m of line.matchAll(/(?<![A-Za-z0-9_.-])\/home\/([A-Za-z0-9._-]+)/g)) if (!PLACEHOLDER_NAMES.test(m[1])) out.push(['linux-user-path', m[0].length]);
  for (const m of line.matchAll(/AppData[\\/]+(?:Local|Roaming|LocalLow)/gi)) out.push(['windows-appdata-path', m[0].length]);
  for (const m of line.matchAll(/[A-Za-z]:[\\/]+(?:Windows[\\/]+Temp|Temp)[\\/]/gi)) out.push(['windows-temp-path', m[0].length]);
  for (const name of names) if (name && name.length >= 3) { const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i'); if (re.test(line)) out.push(['private-name', name.length]); }
  return out;
}

// The user, host and WSL account names of this machine: any of them in a release is a leak.
export function privateNames(root) {
  const names = new Set();
  try { names.add(os.userInfo().username); } catch { /* no user info */ }
  try { names.add(os.hostname()); } catch { /* no host name */ }
  try { const state = JSON.parse(readFileSync(resolve(root, '.local/openshell-panel-state.json'), 'utf8')); if (state.linuxUser) names.add(state.linuxUser); } catch { /* panel never started */ }
  return [...names].filter(n => n && !PLACEHOLDER_NAMES.test(n));
}

// A value that is plainly made up for a test: an alphabet or digit run ("abcdefghij", "0123456789") or one character repeated. Only the source scan
// (allowSynthetic) accepts these, so the test fixtures that prove redaction can live in the repository; a release never does.
const SYNTHETIC = /abcdefghij|0123456789|(.)\1{9,}/;

// Findings for one text. `names` are the private names to look for.
export function scanText(text, { names = [], file = '(text)', allowSynthetic = false } = {}) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  const secretAt = (line, i) => { for (const [rule, re] of SECRET_RULES) { const m = re.exec(line); if (m && !(allowSynthetic && SYNTHETIC.test(m[0]))) findings.push({ file, line: i + 1, rule, length: m[0].length }); } };
  lines.forEach((line, i) => {
    if (line.length > 20000) { secretAt(line.slice(0, 20000), i); return; }
    secretAt(line, i);
    for (const [rule, length] of pathFindings(line, names)) findings.push({ file, line: i + 1, rule, length });
  });
  return findings;
}
export const formatFinding = f => `${f.file}:${f.line}  ${f.rule} (${f.length} characters, value not shown)`;

// ---- Which files Git would stage: a small .gitignore evaluator ----------------------------------------------------------------
// Supports comments, "!" negation, trailing "/" (directories), leading "/" (anchored), "*" and "?" in one path segment and "**".
function patternToRegExp(pattern) {
  let p = pattern.replace(/\/+$/, '');
  const anchored = p.startsWith('/') || p.includes('/');
  p = p.replace(/^\//, '');
  const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp((anchored ? '^' : '(?:^|/)') + body + '(?:/.*)?$');
}
export function parseGitignore(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1) : line;
    rules.push({ negate, dirOnly: pattern.endsWith('/'), re: patternToRegExp(pattern) });
  }
  return rules;
}
// A path is ignored when the last matching rule is not a negation (directories above it are checked first, as Git does).
export function isIgnored(rel, rules, isDirectory = false) {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    const dir = i < parts.length || isDirectory;
    let ignored = false;
    for (const r of rules) if (r.re.test(sub) && (!r.dirOnly || dir || i < parts.length)) ignored = !r.negate;
    if (ignored) return true;
  }
  return false;
}
// Every file under root that Git would consider for staging (never descends into .git or ignored directories).
export function candidateFiles(root) {
  const rules = parseGitignore(existsSync(resolve(root, '.gitignore')) ? readFileSync(resolve(root, '.gitignore'), 'utf8') : '');
  const out = [];
  const walk = rel => {
    for (const name of readdirSync(resolve(root, rel || '.')).sort()) {
      if (name === '.git') continue;
      const child = rel ? `${rel}/${name}` : name;
      const st = statSync(resolve(root, child));
      if (isIgnored(child, rules, st.isDirectory())) continue;
      if (st.isDirectory()) walk(child); else out.push(child);
    }
  };
  walk('');
  return out;
}
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
