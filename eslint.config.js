import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules', 'cdk.out', 'agent/dist', 'coverage'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Estándar de code review de DinoCloud: nombres descriptivos en camelCase. Las constantes van
      // en UPPER_CASE, los tipos, clases y schemas de zod en PascalCase. Las propiedades quedan
      // libres porque copian APIs externas (Meta, AWS) que usan snake_case.
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: ['objectLiteralProperty', 'typeProperty', 'objectLiteralMethod', 'import'], format: null },
      ],
    },
  },
  // Prettier se encarga del formato: apaga las reglas de estilo que chocarían con él.
  prettier,
);
