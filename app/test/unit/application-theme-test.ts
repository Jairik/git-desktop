import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'
import {
  ApplicationTheme,
  getPersistedThemeName,
  getThemeName,
  isDarkTheme,
  selectableThemes,
} from '../../src/ui/lib/application-theme'

/** The palette themes — every selectable theme except the built-in Light/Dark. */
const customThemes = selectableThemes.filter(
  theme => theme !== ApplicationTheme.Light && theme !== ApplicationTheme.Dark
)

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

  it('keeps an explicit custom theme', () => {
    // Consume the one-time dark default migration, then persist a custom theme.
    getPersistedThemeName()
    localStorage.setItem('theme', ApplicationTheme.Ghostty)
    assert.equal(getPersistedThemeName(), ApplicationTheme.Ghostty)
  })
})

describe('theme metadata', () => {
  beforeEach(() => localStorage.clear())

  it('lists every selectable theme exactly once', () => {
    assert.ok(selectableThemes.length > 0)
    assert.equal(new Set(selectableThemes).size, selectableThemes.length)
    assert.equal(customThemes.length > 0, true)
  })

  it('round-trips every selectable theme through storage', () => {
    // Consume the one-time dark default migration before persisting choices.
    getPersistedThemeName()

    for (const theme of selectableThemes) {
      localStorage.setItem('theme', theme)
      assert.equal(getPersistedThemeName(), theme, `${theme} persisted`)
    }
  })

  it('maps light to a light native theme and every other theme to dark', () => {
    for (const theme of selectableThemes) {
      const isLight = theme === ApplicationTheme.Light
      assert.equal(getThemeName(theme), isLight ? 'light' : 'dark')
      assert.equal(isDarkTheme(theme), !isLight)
    }

    assert.equal(getThemeName(ApplicationTheme.System), 'system')
  })
})
