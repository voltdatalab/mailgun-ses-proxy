import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const braces = require('braces')
const guardMessage = 'Brace nesting exceeds maximum depth of 128'

function deepAst(depth: number) {
  let node: any = { type: 'text', value: 'a' }
  for (let i = 0; i < depth; i++) {
    const parent: any = { type: 'brace', nodes: [node], commas: 0, ranges: 0 }
    node.parent = parent
    node = parent
  }
  const root = { type: 'root', nodes: [node] }
  node.parent = root
  return root
}

describe('vendored braces depth limit (GHSA-vfj7-8cjw-p6xm)', () => {
  const patterns = [
    '{'.repeat(4900) + 'a,b' + '}'.repeat(4900),
    '('.repeat(3000) + 'a' + ')'.repeat(3000),
    '{('.repeat(1500) + 'a,b' + ')}'.repeat(1500),
    '{'.repeat(3000) + 'a',
    '${'.repeat(1500) + 'a' + '}'.repeat(1500),
  ]
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    it(`${method} rejects excessive string nesting with the explicit guard`, () => {
      for (const pattern of patterns) {
        expect(() => braces[method](pattern, { maxLength: Infinity })).toThrow(guardMessage)
      }
    })
  }
  for (const method of ['compile', 'expand', 'stringify']) {
    it(`${method} guards AST inputs that bypass parsing`, () => {
      expect(() => braces[method](deepAst(10000))).toThrow(guardMessage)
    })
  }
  it('preserves normal alternatives, ranges, escapes and invalid literals', () => {
    expect(braces.expand('src/{app,lib}/file{1..3}.ts')).toEqual([
      'src/app/file1.ts', 'src/app/file2.ts', 'src/app/file3.ts',
      'src/lib/file1.ts', 'src/lib/file2.ts', 'src/lib/file3.ts',
    ])
    expect(braces.compile('a/{b,c}/d')).toBe('a/(b|c)/d')
    expect(braces.expand('a/\\{b,c\\}/d')).toEqual(['a/{b,c}/d'])
    expect(braces.expand('a/{b')).toEqual(['a/{b'])
    expect(braces.stringify(braces.parse('a/{b,c}/d'))).toBe('a/{b,c}/d')
    expect(braces.compile('{abc}', { escapeInvalid: true })).toBe('\\{abc\\}')
    expect(braces.expand('{'.repeat(50) + 'a,b' + '}'.repeat(50))).toHaveLength(2)
  })
})
