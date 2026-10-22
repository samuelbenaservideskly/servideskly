import { logger } from '../lib/logger.js';
import { getAsset, onAssetChange, type AssetChange } from './assets.js';
import { assetVariables } from './asset-variables.js';
import { notifyPerson } from './mail/outbox.js';
import { findUserById } from './users.js';

const log = logger.child({ module: 'assets' });

/**
 * Emails when an asset changes hands (step 3 of assets, 21 Oct 2026): the
 * person it is now assigned to gets "An asset is assigned to you", the one
 * it was taken back from "An asset is taken back". Both are built-in
 * notifications (Mail - Notifications), editable and translatable, sent
 * with notifyPerson() like the temporary password.
 *
 * A mail that cannot go (no mailbox, the notification switched off) never
 * stops the change it is about: it is logged and the asset is saved.
 */
async function sendFor(change: AssetChange): Promise<void> {
  if (change.assigneeFrom === change.assigneeTo) return;
  const asset = await getAsset(change.assetId);
  if (!asset) return;
  if (change.assigneeFrom) {
    const before = await findUserById(change.assigneeFrom);
    if (before?.email && before.status === 'active') {
      await notifyPerson('asset.unassigned', before.email, await assetVariables(asset, before));
    }
  }
  if (change.assigneeTo) {
    const now = await findUserById(change.assigneeTo);
    if (now?.email) await notifyPerson('asset.assigned', now.email, await assetVariables(asset, now));
  }
}

let registered = false;

/** Called once from createApp(). */
export function registerAssetNotifications(): void {
  if (registered) return;
  registered = true;
  onAssetChange(async (change) => {
    try {
      await sendFor(change);
    } catch (err) {
      log.warn({ err, assetId: change.assetId }, 'asset notification not sent');
    }
  });
}
