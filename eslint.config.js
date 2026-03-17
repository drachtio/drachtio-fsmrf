const globals = require('globals');
const promisePlugin = require('eslint-plugin-promise');

module.exports = [
  {
    files: ['lib/**/*.js'],
    plugins: {
      promise: promisePlugin
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es6
      }
    },
    rules: {
      // Promise rules
      'promise/always-return': 'error',
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-native': 'off',
      'promise/no-nesting': 'warn',
      'promise/no-promise-in-callback': 'warn',
      'promise/no-callback-in-promise': 'warn',
      'promise/no-return-in-finally': 'warn',

      // Possible Errors
      'comma-dangle': [2, 'only-multiline'],
      'no-control-regex': 2,
      'no-debugger': 2,
      'no-dupe-args': 2,
      'no-dupe-keys': 2,
      'no-duplicate-case': 2,
      'no-empty-character-class': 2,
      'no-ex-assign': 2,
      'no-extra-boolean-cast': 2,
      'no-extra-parens': [2, 'functions'],
      'no-extra-semi': 2,
      'no-func-assign': 2,
      'no-invalid-regexp': 2,
      'no-irregular-whitespace': 2,
      'no-unsafe-negation': 2,
      'no-obj-calls': 2,
      'no-proto': 2,
      'no-unexpected-multiline': 2,
      'no-unreachable': 2,
      'use-isnan': 2,
      'valid-typeof': 2,

      // Best Practices
      'no-fallthrough': 2,
      'no-octal': 2,
      'no-redeclare': 2,
      'no-self-assign': 2,
      'no-unused-labels': 2,

      // Strict Mode
      'strict': [2, 'never'],

      // Variables
      'no-delete-var': 2,
      'no-undef': 2,
      'no-unused-vars': [2, {'args': 'none'}],

      // Stylistic Issues
      'comma-spacing': 2,
      'eol-last': 2,
      'indent': [2, 2, {'SwitchCase': 1}],
      'keyword-spacing': 2,
      'max-len': [2, 120, 2],
      'new-parens': 2,
      'no-mixed-spaces-and-tabs': 2,
      'no-multiple-empty-lines': [2, {'max': 2}],
      'no-trailing-spaces': [2, {'skipBlankLines': false}],
      'quotes': [2, 'single', 'avoid-escape'],
      'semi': 2,
      'space-before-blocks': [2, 'always'],
      'space-before-function-paren': [2, 'never'],
      'space-in-parens': [2, 'never'],
      'space-infix-ops': 2,
      'space-unary-ops': 2,

      // ECMAScript 6
      'arrow-parens': [2, 'always'],
      'arrow-spacing': [2, {'before': true, 'after': true}],
      'constructor-super': 2,
      'no-class-assign': 2,
      'no-confusing-arrow': 2,
      'no-const-assign': 2,
      'no-dupe-class-members': 2,
      'no-new-native-nonconstructor': 2,
      'no-this-before-super': 2,
      'prefer-const': 2
    }
  }
];
