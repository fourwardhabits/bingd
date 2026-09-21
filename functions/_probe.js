/**
 * TEMPORARY placement probe. Deleted once the Pages root directory is known.
 *
 * `docs/architecture/web-deployment.md` says the project's root and output
 * directories are *inferred from deployed bytes* rather than confirmed, and a
 * misplaced Pages Function is invisible to a browser — the static page renders
 * either way. This answers the question from outside, with no dashboard access.
 */
export const onRequest = () =>
  new Response('root: repository root (functions/)\n', {
    headers: { 'content-type': 'text/plain', 'x-bingd-probe': 'repo-root' },
  });
