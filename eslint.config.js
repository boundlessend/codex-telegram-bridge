export default [
  {
    ignores: [
      "node_modules/**",
      "state/**",
      "coverage/**",
      "*.tgz"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        Intl: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly"
      }
    },
    rules: {
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }]
    }
  }
];
