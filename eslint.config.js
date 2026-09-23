// @ts-check
const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier');

/** Matches #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

module.exports = [
  ...expoConfig,
  prettier,
  {
    ignores: [
      'node_modules/**',
      'design-references/**',
      '.expo/**',
      'dist/**',
      'android/**',
      'ios/**',
      '.cursor/**',
      '.agents/**',
      // Deno, not React Native. Its imports carry .ts extensions and its globals are
      // not Node's, so the Expo config flags correct code — `deno lint` covers it.
      'supabase/functions/**',
    ],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Command-line scripts, where printing a report is the whole point rather than
    // a leftover debug statement, and where Node's own globals are in scope.
    files: [
      'supabase/**/*.mjs',
      'web/*.mjs',
      'scripts/**/*.mjs',
      'assets/**/*.mjs',
      'store-assets/**/*.mjs',
      'eval/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    /**
     * Cloudflare Pages Functions, which run on the Workers runtime rather than in Node
     * or in a browser.
     *
     * `HTMLRewriter` is the one global worth naming: it is Cloudflare's streaming HTML
     * parser and exists nowhere else, so without this entry the only Function in the
     * repo fails lint for using the API it was written for. The rest are standard and
     * listed because a flat-config scope inherits no environment.
     *
     * Deliberately **not** folded into the Node-scripts block above: these files have no
     * `process`, no `Buffer` and no `__dirname`, and pretending otherwise is how
     * somebody reaches for one and finds out at the edge.
     */
    files: ['functions/**/*.js'],
    languageOptions: {
      globals: {
        HTMLRewriter: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['jest.setup.js', '**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
  {
    // docs/design/design-system.md §11: a hex value may appear only in the token
    // file. Without this, a hardcoded #D4A64C reintroduces the exact contrast
    // defect that document opens with.
    files: ['src/features/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    ignores: ['src/ui/tokens/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=${HEX_COLOR}]`,
          message:
            'Raw color literals are banned outside src/ui/tokens. Use a token from @/ui/tokens — see docs/design/design-system.md §11.',
        },
        {
          selector: `TemplateElement[value.raw=${HEX_COLOR}]`,
          message:
            'Raw color literals are banned outside src/ui/tokens. Use a token from @/ui/tokens — see docs/design/design-system.md §11.',
        },
      ],
    },
  },
];
