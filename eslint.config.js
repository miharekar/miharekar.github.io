module.exports = [
  {
    ignores: [
      "assets/js/plugins/**",
      "assets/js/vendor/**",
      "assets/js/scripts.min.js",
    ],
  },
  {
    files: ["assets/js/_*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        $: "readonly",
        jQuery: "readonly",
        console: "readonly",
        document: "readonly",
        getComputedStyle: "readonly",
        navigator: "readonly",
        window: "readonly",
      },
    },
    rules: {
      curly: "error",
      eqeqeq: ["error", "always", { "null": "ignore" }],
      "new-cap": "error",
      "no-bitwise": "error",
      "no-caller": "error",
      "no-multi-str": "off",
      "no-unused-expressions": "off",
      "no-use-before-define": ["error", { "functions": false, "classes": true, "variables": true }],
      "no-undef": "error",
      strict: "off",
    },
  },
];
