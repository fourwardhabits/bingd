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
    // a leftover debug statement.
    files: ['supabase/**/*.mjs', 'web/*.mjs'],
    rules: {
      'no-console': 'off',
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
