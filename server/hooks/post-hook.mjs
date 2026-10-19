// Claude Code command hook: forwards the hook's JSON (stdin) to the app at the URL in argv[2].
// Kept dependency-free and never fails the session: errors are swallowed.
const url = process.argv[2];
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', async () => {
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  } catch {
    // The app may be restarting; the init message still carries the session id.
  }
});
