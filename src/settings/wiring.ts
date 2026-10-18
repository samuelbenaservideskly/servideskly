import { onSettingsChanged } from './index.js';
import { resetDiscoveryCache } from '../auth/oidc.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'settings-wiring' });

let installed = false;

/**
 * Connects settings changes to the caches that would otherwise keep serving
 * the old configuration.
 *
 * The OIDC discovery document and its key set are fetched once and cached, so
 * without this, changing the tenant in the UI would appear to work and then
 * quietly keep using the previous one.
 */
export function installSettingsWiring(): void {
  if (installed) return;
  installed = true;

  onSettingsChanged(() => {
    resetDiscoveryCache();
    log.info('settings changed: the identity provider cache was cleared');
  });
}
