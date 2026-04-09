let security = null;
try {
  security = require('eslint-plugin-security');
} catch (_error) {
  security = null;
}

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'Audit-09042026/**',
      'logs/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    plugins: security ? { security } : {},
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
      'eqeqeq': 'error',
      ...(security
        ? {
            'security/detect-non-literal-regexp': 'warn',
            'security/detect-possible-timing-attacks': 'warn',
          }
        : {}),
    },
  },
  {
    files: ['web/public/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Event: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        Image: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
      },
    },
    rules: {
      // Browser globals vary per runtime; keep no-undef strict for server-side code.
      'no-undef': 'off',
    },
  },
];
