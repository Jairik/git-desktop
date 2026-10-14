import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  parseCommitMessage,
  prepareDiff,
} from '../../src/lib/local-agent/shared'

describe('local agent parseCommitMessage', () => {
  it('splits a fenced commit block into title and description', () => {
    const text =
      'Here you go:\n\n```commit\nfeat(ui): add button\n\nAdds a button.\n\n- One\n```\n'
    assert.deepStrictEqual(parseCommitMessage(text), {
      title: 'feat(ui): add button',
      description: 'Adds a button.\n\n- One',
    })
  })

  it('uses the last fenced block', () => {
    const text = '```\nignored\n```\n\n```commit\nfix: real\n```'
    assert.deepStrictEqual(parseCommitMessage(text), {
      title: 'fix: real',
      description: '',
    })
  })

  it('falls back to the raw text when there is no fence', () => {
    assert.deepStrictEqual(parseCommitMessage('\nchore: tidy\nbody\n'), {
      title: 'chore: tidy',
      description: 'body',
    })
  })

  it('throws on an empty message', () => {
    assert.throws(() => parseCommitMessage('```commit\n\n```'))
  })
})

describe('local agent prepareDiff', () => {
  const patch = (name: string, body: string) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${body}\n`

  it('keeps small diffs whole and drops the raw header', () => {
    const diff = ':100644 100644 abc def M\ta.ts\n\n' + patch('a.ts', '+one')
    const result = prepareDiff(diff)
    assert.equal(result.fileCount, 1)
    assert.equal(result.includedFileCount, 1)
    assert.equal(result.text, patch('a.ts', '+one'))
  })

  it('lists files that do not fit by name', () => {
    const diff =
      patch('small.ts', '+x') +
      patch('huge.bin', '+' + 'y'.repeat(500)) +
      patch('also-small.ts', '+z')
    const result = prepareDiff(diff, 200)
    assert.equal(result.fileCount, 3)
    assert.equal(result.includedFileCount, 2)
    assert.ok(result.text.includes('+x'))
    assert.ok(result.text.includes('+z'))
    assert.ok(!result.text.includes('yyyy'))
    assert.ok(result.text.includes('a/huge.bin b/huge.bin'))
  })
})
