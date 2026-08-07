import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('serve-registry --port validation', () => {
  it.each(['-1', '99999', 'abc'])(
    'exits non-zero and reports Invalid --port for %s',
    (port) => {
      const result = spawnSync('node', ['scripts/serve-registry.mjs', '--port', port], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Invalid --port');
    },
  );
});

describe('serve-registry PORT env validation', () => {
  it.each(['-1', '99999', 'abc'])(
    'exits non-zero and reports Invalid PORT for %s',
    (port) => {
      const result = spawnSync('node', ['scripts/serve-registry.mjs'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, PORT: port },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Invalid PORT');
    },
  );
});
