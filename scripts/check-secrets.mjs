// Fails when a tracked or to-be-committed file looks like it contains a credential.
// Deliberately simple: it catches the common mistakes; it does not replace a full scanner.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const list = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);

let files;
try {
  // Tracked files plus untracked-but-not-ignored ones, i.e. everything that could be committed.
  files = [
    ...new Set([...list('ls-files'), ...list('ls-files', '--others', '--exclude-standard')]),
  ];
} catch {
  console.error('check-secrets: not a git repository');
  process.exit(1);
}

const FORBIDDEN_NAME = /(^|\/)(\.env(\..+)?|.+\.(pem|key|p12|pfx)|id_(rsa|ed25519).*|.*\.db)$/;
const ALLOWED_NAME = /(^|\/)\.env\.example$/;
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bsk_(live|test)_[A-Za-z0-9]{16,}\b/, 'payment secret key'],
  [/\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'JWT / tunnel token'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{3,}@[^\s/]+/i, 'credentials inside a URL'],
];

// Files that contain deliberately fake credentials (they test the redaction code).
const FAKE_SECRET_FIXTURES = new Set(['apps/api/test/units.test.ts']);

const problems = [];
for (const f of files) {
  if (FORBIDDEN_NAME.test(f) && !ALLOWED_NAME.test(f))
    problems.push(`${f}: file type must not be committed`);
  if (f.endsWith('package-lock.json') || f === 'scripts/check-secrets.mjs') continue;
  if (FAKE_SECRET_FIXTURES.has(f)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  for (const [re, label] of PATTERNS)
    if (re.test(text)) problems.push(`${f}: looks like a ${label}`);
}

if (problems.length) {
  console.error('Possible secrets found:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`check-secrets: ${files.length} files scanned, nothing suspicious`);
