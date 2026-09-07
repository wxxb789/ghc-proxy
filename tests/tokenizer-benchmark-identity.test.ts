import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { readSourceIdentity } from '../scripts/benchmarks/tokenizer-cost'

const SOURCE_FILES = [
  ['src/a.ts', 'export const a = 1\n'],
  ['src/nested/b.ts', 'export const b = 2\n'],
  ['package.json', '{"name":"fixture"}\n'],
  ['bun.lock', 'fixture-lock\n'],
  ['tsconfig.json', '{}\n'],
  ['tsdown.config.ts', 'export default {}\n'],
] as const

describe('tokenizer benchmark source identity', () => {
  test('is deterministic and hashes only selected source inputs', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'ghc-tokenizer-identity-a-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'ghc-tokenizer-identity-b-'))

    try {
      await seedSource(firstRoot, SOURCE_FILES)
      await seedSource(secondRoot, [...SOURCE_FILES].reverse())

      const first = await readSourceIdentity(firstRoot)
      const sameContent = await readSourceIdentity(secondRoot)
      expect(first).toEqual(sameContent)
      expect(first).toMatchObject({ dirty: null, headSha: null, fileCount: 6 })

      await writeFixture(firstRoot, 'docs/report.md', 'ignored docs\n')
      await writeFixture(firstRoot, 'node_modules/pkg/index.js', 'ignored dependency\n')
      await writeFixture(firstRoot, '.compound-engineering/config.local.yaml', 'private: ignored\n')
      expect((await readSourceIdentity(firstRoot)).treeSha256).toBe(first.treeSha256)

      await writeFixture(secondRoot, 'src/a.ts', 'export const a = 3\n')
      const changed = await readSourceIdentity(secondRoot)
      expect(changed.headSha).toBe(first.headSha)
      expect(changed.treeSha256).not.toBe(first.treeSha256)
    }
    finally {
      await Promise.all([
        rm(firstRoot, { force: true, recursive: true }),
        rm(secondRoot, { force: true, recursive: true }),
      ])
    }
  })
})

async function seedSource(root: string, files: ReadonlyArray<readonly [string, string]>) {
  for (const [relativePath, content] of files)
    await writeFixture(root, relativePath, content)
}

async function writeFixture(root: string, relativePath: string, content: string) {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}
