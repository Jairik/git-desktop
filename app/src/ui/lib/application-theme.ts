import {
  isMacOSMojaveOrLater,
  isWindows10And1809Preview17666OrLater,
} from '../../lib/get-os'
import { getBoolean } from '../../lib/local-storage'
import {
  setNativeThemeSource,
  shouldUseDarkColors,
} from '../main-process-proxy'
import { ThemeSource } from './theme-source'

/**
 * A set of the user-selectable appearances (aka themes)
 */
export enum ApplicationTheme {
  Light = 'light',
  Dark = 'dark',
  System = 'system',
  Ghostty = 'ghostty',
  Nord = 'nord',
  Dracula = 'dracula',
  Gruvbox = 'gruvbox',
  TokyoNight = 'tokyo-night',
}

/**
 * The themes that can actually be applied to the app. This is every
 * user-selectable theme except `System`, which is resolved to one of the
 * others at runtime.
 */
export type ApplicableTheme =
  | ApplicationTheme.Light
  | ApplicationTheme.Dark
  | ApplicationTheme.Ghostty
  | ApplicationTheme.Nord
  | ApplicationTheme.Dracula
  | ApplicationTheme.Gruvbox
  | ApplicationTheme.TokyoNight

/**
 * Every theme the user can pick, in the order the Appearance dialog shows them.
 * `System` is intentionally absent: it's resolved to one of these at runtime
 * and only offered when the OS supports reporting appearance changes.
 */
export const selectableThemes: ReadonlyArray<ApplicableTheme> = [
  ApplicationTheme.Light,
  ApplicationTheme.Dark,
  ApplicationTheme.Ghostty,
  ApplicationTheme.Nord,
  ApplicationTheme.Dracula,
  ApplicationTheme.Gruvbox,
  ApplicationTheme.TokyoNight,
]

/**
 * The themes that render on a dark background. When adding a theme, this and
 * `$dark-theme-names` in `app/styles/themes/_custom-theme.scss` must agree.
 */
const darkThemes: ReadonlySet<ApplicableTheme> = new Set([
  ApplicationTheme.Dark,
  ApplicationTheme.Ghostty,
  ApplicationTheme.Nord,
  ApplicationTheme.Dracula,
  ApplicationTheme.Gruvbox,
  ApplicationTheme.TokyoNight,
])

/**
 * Gets the native theme source ('light' | 'dark' | 'system') that should be
 * applied for the given application theme. This drives the OS-level window
 * chrome and is used when reporting the active theme.
 */
export function getThemeName(theme: ApplicationTheme): ThemeSource {
  if (theme === ApplicationTheme.System) {
    return 'system'
  }

  return isDarkTheme(theme) ? 'dark' : 'light'
}

/**
 * Whether the given applicable theme renders on a dark background.
 *
 * This is used to set the document color scheme and the native window colors,
 * and drives dark-only styling that isn't expressed through CSS variables.
 */
export function isDarkTheme(theme: ApplicableTheme): boolean {
  return darkThemes.has(theme)
}

/**
 * Resolves a user's selected theme to the theme that should actually be
 * applied. `System` is resolved to the currently active light/dark appearance,
 * every other theme is applied as-is.
 */
export async function resolveApplicableTheme(
  theme: ApplicationTheme
): Promise<ApplicableTheme> {
  return theme === ApplicationTheme.System
    ? await getCurrentlyAppliedTheme()
    : theme
}

// The key under which the decision to automatically switch the theme is persisted
// in localStorage.
const automaticallySwitchApplicationThemeKey = 'autoSwitchTheme'

/**
 * Function to preserve and convert legacy theme settings
 * should be removable after most users have upgraded to 2.7.0+
 */
function migrateAutomaticallySwitchSetting(): string | null {
  const automaticallySwitchApplicationTheme = getBoolean(
    automaticallySwitchApplicationThemeKey,
    false
  )

  localStorage.removeItem(automaticallySwitchApplicationThemeKey)

  if (automaticallySwitchApplicationTheme) {
    setPersistedTheme(ApplicationTheme.System)
    return 'system'
  }

  return null
}

// The key under which the currently selected theme is persisted
// in localStorage.
const applicationThemeKey = 'theme'

// Set once this fork has switched an existing install over to dark mode, so a
// later explicit choice of 'system' is respected.
const darkDefaultAppliedKey = 'theme-dark-default-applied'

/**
 * Returns User's theme preference, or dark if not set or parsable. Upstream
 * defaults to 'system' and persists it on first launch, so that value is
 * migrated to dark once.
 */
function getApplicationThemeSetting(): ApplicationTheme {
  const themeSetting = localStorage.getItem(applicationThemeKey)
  const darkDefaultApplied = localStorage.getItem(darkDefaultAppliedKey)

  if (darkDefaultApplied === null) {
    localStorage.setItem(darkDefaultAppliedKey, '1')
    if (themeSetting !== ApplicationTheme.Light) {
      return ApplicationTheme.Dark
    }
  }

  if (isApplicationTheme(themeSetting)) {
    return themeSetting
  }

  return ApplicationTheme.Dark
}

/**
 * Guards against unrecognized values in persistent storage (e.g. a theme that
 * was removed in a later version). Keeping the list in one place makes adding
 * a new theme a matter of extending the enum and this check.
 */
function isApplicationTheme(value: string | null): value is ApplicationTheme {
  return (
    value === ApplicationTheme.System ||
    selectableThemes.some(theme => theme === value)
  )
}

/**
 * Load the name of the currently selected theme
 */
export async function getCurrentlyAppliedTheme(): Promise<ApplicableTheme> {
  return (await isDarkModeEnabled())
    ? ApplicationTheme.Dark
    : ApplicationTheme.Light
}

/**
 * Load the name of the currently selected theme
 */
export function getPersistedThemeName(): ApplicationTheme {
  if (migrateAutomaticallySwitchSetting() === 'system') {
    return ApplicationTheme.System
  }

  return getApplicationThemeSetting()
}

/**
 * Stores the given theme in the persistent store.
 */
export function setPersistedTheme(theme: ApplicationTheme): void {
  const themeName = getThemeName(theme)
  localStorage.setItem(applicationThemeKey, theme)
  setNativeThemeSource(themeName)
}

/**
 * Whether or not the current OS supports System Theme Changes
 */
export function supportsSystemThemeChanges(): boolean {
  if (__DARWIN__) {
    return isMacOSMojaveOrLater()
  } else if (__WIN32__) {
    // Its technically possible this would still work on prior versions of Windows 10 but 1809
    // was released October 2nd, 2018 and the feature can just be "attained" by upgrading
    // See https://github.com/desktop/desktop/issues/9015 for more
    return isWindows10And1809Preview17666OrLater()
  } else {
    // enabling this for Linux users as an experiment to see if distributions
    // work with how Chromium detects theme changes
    return true
  }
}

function isDarkModeEnabled(): Promise<boolean> {
  return shouldUseDarkColors()
}
