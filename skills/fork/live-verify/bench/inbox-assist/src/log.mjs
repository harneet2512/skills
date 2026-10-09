// Structured JSON-line logs. Callers pass ids, counts and reasons, never message
// bodies or tokens. `cid` (correlation id) ties a push to its Slack post and send.
export function createLogger(base = {}) {
  const write = (level, event, fields = {}) => {
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...base, ...fields }) + '\n');
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}
