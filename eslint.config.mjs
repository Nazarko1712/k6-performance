import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/**
 * ESLint 9 flat config.
 *
 * k6 scripts are the awkward case in this portfolio: they are JavaScript, but
 * they do not run on Node. They run on k6's own goja runtime, which supplies
 * `open()`, `__VU` and `__ITER` as globals and resolves `k6/http` from inside
 * the binary rather than from node_modules. Linting them with Node globals
 * produces a page of false `no-undef` errors, so the two environments are
 * separated:
 *
 *   tests/, lib/      the k6 runtime — k6 globals, no Node globals
 *   server/, scripts/ ordinary Node — the local target app and the wrapper
 *                     that starts it
 *
 * `no-undef` is the rule that earns its keep here. k6 has no `setTimeout` and
 * no `fetch`; writing either produces a runtime error inside a load test, which
 * is the worst place to discover it, because the failure shows up as a wall of
 * identical iteration errors rather than as one clear message.
 */
export default [
    {
        ignores: ['node_modules/', 'results.json', 'summary.html', 'eslint.config.mjs'],
    },

    js.configs.recommended,

    {
        files: ['tests/**/*.js', 'lib/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Supplied by the goja runtime, not importable.
                __VU: 'readonly',
                __ITER: 'readonly',
                __ENV: 'readonly',
                open: 'readonly',
                console: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },

    {
        files: ['server/**/*.js', 'scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'require-await': 'error',
        },
    },

    prettier,
];
