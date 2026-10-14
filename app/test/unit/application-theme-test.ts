import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import {
  ApplicationTheme,
  getPersistedThemeName,
} from '../../src/ui/lib/application-theme'

describe('getPersistedThemeName', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to dark on a fresh install', () => {
    assert.equal(getPersistedThemeName(), ApplicationTheme.Dark)
  })

  it('migrates the upstream system default to dark once', () => {
    localStorage.setItem('theme', ApplicationTheme.System)
    assert.equal(getPersistedThemeName(), ApplicationTheme.Dark)

    // A later explicit choice of 'system' is respected
    localStorage.setItem('theme', ApplicationTheme.System)
    assert.equal(getPersistedThemeName(), ApplicationTheme.System)
  })

  it('keeps an explicit light theme', () => {
    localStorage.setItem('theme', ApplicationTheme.Light)
    assert.equal(getPersistedThemeName(), ApplicationTheme.Light)
  })
})
