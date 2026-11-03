#!/usr/bin/env node
/**
 * Stage 1: raw PNGs of the real app, from the scene manifest.
 *
 *   node capture/run.mjs --source <ref|folder> --node-modules <path> [--scenes a,b]
 *
 * See README.md. `--serve` builds and leaves Metro running, `--attach` shoots against a
 * running one, and `--stop` stops only the server recorded in this workdir.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { csv, OUT, parseArgs } from '../lib/common.mjs';
import { scenes as allScenes } from '../manifest/scenes.mjs';
import { DEVICE, shootScenes } from './browser.mjs';
import { startExpo, stopExpo, waitForBundle } from './expo-server.mjs';
import { FIXED_NOW, startMock } from './mock/backend.mjs';
import { prepareSource, resolveSource } from './prepare-source.mjs';

const args = parseArgs(process.argv.slice(2), {
  source: 'value',
  'node-modules': 'value',
  scenes: 'value',
  out: 'value',
  workdir: 'value',
  'metro-port': 'value',
  'mock-port': 'value',
  serve: 'flag',
  attach: 'flag',
  stop: 'flag',
  fresh: 'flag',
});

const metroPort = Number(args['metro-port'] ?? 8199);
const mockPort = Number(args['mock-port'] ?? 54499);
const outDir = resolve(args.out ?? join(OUT, 'raw'));

function workdirFor(input) {
  if (args.workdir) return resolve(args.workdir);
  const slug = (input ?? 'default').replace(/[^A-Za-z0-9._-]+/g, '-').slice(-60);
  return join(tmpdir(), 'bingd-screenshots', slug);
}

/** A raw folder describes one build. Compose must never mix two. */
function loadRecord(file, source) {
  if (args.fresh || !existsSync(file)) return { scenes: {} };
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.source?.sha !== source.sha) {
    throw new Error(
      `${outDir} holds captures of ${record.source?.sha ?? 'an unknown build'}, not ${source.sha}.\n` +
        'Pass --fresh to replace them or --out for a separate folder.',
    );
  }
  return record;
}

async function main() {
  const workdir = workdirFor(args.source);

  if (args.stop) {
    console.log(stopExpo(workdir) ? `stopped the server for ${workdir}` : 'no server recorded here');
    return;
  }

  if (!args.source) throw new Error('--source <git ref or folder> is required');
  const source = resolveSource(args.source);

  const selected = csv(args.scenes);
  const scenes = selected
    ? selected.map((id) => {
        const scene = allScenes.find((s) => s.id === id);
        if (!scene) throw new Error(`No scene "${id}" in manifest/scenes.mjs`);
        return scene;
      })
    : allScenes;

  const baseUrl = `http://127.0.0.1:${metroPort}`;
  let expo = null;

  if (!args.attach) {
    if (!args['node-modules']) {
      throw new Error('--node-modules <path> is required: the installed deps of a checkout of this source');
    }
    const prepared = prepareSource({
      source,
      workdir,
      nodeModules: resolve(args['node-modules']),
      mockPort,
    });
    console.log(`exported ${source.sha ?? source.path} to ${workdir}`, prepared.patches);
    expo = await startExpo({ workdir, port: metroPort });
    console.log(`metro pid ${expo.pid} on ${baseUrl}; the first build is slow`);
  }

  try {
    await waitForBundle(metroPort, { isAlive: expo?.isAlive });

    if (args.serve) {
      console.log(`serving; stop with: node capture/run.mjs --stop --source ${args.source}`);
      expo = null; // Leaves the server up for --attach.
      return;
    }

    mkdirSync(outDir, { recursive: true });
    const recordFile = join(outDir, 'capture.json');
    const record = loadRecord(recordFile, source);
    if (args.fresh) {
      // Only this stage's own files: --out may have been pointed somewhere that holds others.
      for (const name of readdirSync(outDir)) {
        if (name.endsWith('.png') || name === 'capture.json') rmSync(join(outDir, name));
      }
    }

    const mock = await startMock(mockPort);
    let outcome;
    try {
      outcome = await shootScenes({ scenes, baseUrl, mock, outDir });
      record.unhandledBackendCalls = mock.unhandled();
    } finally {
      await mock.stop();
    }

    Object.assign(record, {
      source: { input: source.input, kind: source.kind, sha: source.sha },
      device: DEVICE,
      fixedNow: new Date(FIXED_NOW).toISOString(),
      chrome: outcome.chrome,
      scenes: { ...record.scenes, ...outcome.results },
    });
    writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);

    const blocked = [...new Set(Object.values(outcome.results).flatMap((r) => r.blocked))];
    console.log(`\n${Object.keys(outcome.results).length} scene(s) in ${outDir}`);
    if (blocked.length) console.log(`blocked hosts: ${blocked.join(', ')}`);
    const unhandled = Object.keys(record.unhandledBackendCalls ?? {});
    if (unhandled.length) console.log(`unhandled backend calls:\n  ${unhandled.join('\n  ')}`);
    if (outcome.failures.length) {
      for (const f of outcome.failures) console.error(`FAILED ${f.scene}: ${f.error}`);
      process.exitCode = 1;
    }
  } finally {
    if (expo) expo.stop();
  }
}

main().catch((error) => {
  console.error(`\ncapture failed: ${error.message}`);
  process.exitCode = 1;
});
