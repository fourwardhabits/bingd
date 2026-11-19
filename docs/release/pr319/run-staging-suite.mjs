// Runs one credentialed suite against bingd staging with keys held only in the child's env.
// The keys come from the Supabase management API (the proxy injects the access token);
// nothing is printed or written, and the child's output is scrubbed of both keys.
import { spawn } from 'node:child_process';

const REF = 'fjxhcbowoxuzulwirzyr';
const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node run-staging-suite.mjs <suite.mjs> [args]');
  process.exit(2);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`);
if (!res.ok) {
  console.error(`api-keys: HTTP ${res.status}`);
  process.exit(1);
}
const keys = await res.json();
const pick = (name) => keys.find((k) => k.name === name)?.api_key;
const anon = pick('anon');
const service = pick('service_role');
if (!anon || !service) {
  console.error(`api-keys: missing ${!anon ? 'anon ' : ''}${!service ? 'service_role' : ''}`);
  process.exit(1);
}

const url = `https://${REF}.supabase.co`;
const child = spawn(process.execPath, [script, ...args], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SUPABASE_URL: url,
    EXPO_PUBLIC_SUPABASE_URL: url,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const scrub = (chunk) => chunk.toString().split(service).join('<service>').split(anon).join('<anon>');
child.stdout.on('data', (c) => process.stdout.write(scrub(c)));
child.stderr.on('data', (c) => process.stderr.write(scrub(c)));
child.on('close', (code) => process.exit(code ?? 1));
