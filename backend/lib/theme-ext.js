/**
 * Backward-compatible theme extension exports.
 * New code should import the generic runtime from theme-runtime.js.
 */
export {
  loadThemeRuntime,
  registerThemeExtensions,
  resolveActiveThemeId,
} from './theme-runtime.js';

import { loadThemeRuntime } from './theme-runtime.js';

export async function loadThemeExtensions(themesDir) {
  return (await loadThemeRuntime(themesDir)).extensions;
}
