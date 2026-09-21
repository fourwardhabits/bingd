import { execFileSync } from 'node:child_process';
const platform = process.argv[2];
const out = execFileSync('npx', ['expo-updates', 'fingerprint:generate', '--platform', platform], {
  encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, BINGD_LANE: 'preview', APP_VARIANT: 'preview' },
});
const i = out.indexOf('{"sources"');
const j = JSON.parse(out.slice(i));
console.log(`RESULT ${platform} hash=${j.hash} sources=${j.sources.length}`);
