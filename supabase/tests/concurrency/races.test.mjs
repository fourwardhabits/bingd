import { after, before } from 'node:test';

import { startCluster, stopCluster } from './harness.mjs';

import notificationBlock from './races/notification-block.mjs';
import operationIntent from './races/operation-intent.mjs';
import lockPair from './races/lock-pair.mjs';
import followMatrix from './races/follow-matrix.mjs';
import recommendation from './races/recommendation.mjs';
import inviteToken from './races/invite-token.mjs';
import inviteRedeem from './races/invite-redeem.mjs';
import rateLimit from './races/rate-limit.mjs';
import ranking from './races/ranking.mjs';
import stress from './races/stress.mjs';

/**
 * The race suites, in one process and therefore on one cluster.
 *
 * `node --test` gives each `*.test.mjs` its own process, and booting a PostgreSQL
 * costs about twenty seconds — so eight files would be three minutes of `initdb`
 * before a single assertion ran, and a suite that slow stops being run. The suites
 * are therefore plain modules under `races/`, imported here.
 *
 * Each registers its own `describe` and takes its own database, cloned from the
 * shared template. Nothing is shared between them but the postmaster.
 */

before(async () => {
  await startCluster();
});

after(async () => {
  await stopCluster();
});

notificationBlock();
operationIntent();
lockPair();
followMatrix();
recommendation();
inviteToken();
inviteRedeem();
rateLimit();
ranking();
stress();
