import { config } from '../config.js';
import { listColumns, listStatuses, type AssetListItem, type AssetRow } from './assets.js';
import { findUserById, type UserRow } from './users.js';

/**
 * The variables an asset gives a notification, an automation's email and a
 * document (steps 3 to 5 of assets, 21 Oct 2026). One list, so the three
 * never disagree about what {{SerialNumber}} means.
 *
 * - **Every column by its key**, switched on or not: {{Model}},
 *   {{SerialNumber}}, {{DateBought}}... and any column of your own.
 * - **The person** it is assigned to (or another, say the one it was taken
 *   back from): {{FirstName}}, {{LastName}}, {{FullName}}, {{Email}},
 *   {{Department}}, {{JobTitle}}, {{Manager}}.
 * - {{Company}} is the asset's Company column, else the person's company:
 *   a buyout letter is addressed to whoever has the asset.
 * - {{Status}}, {{AssetLink}} and {{Today}}.
 *
 * Names are letters only (no dots): the notification renderer reads `\w+`.
 */

export const PERSON_VARIABLES = ['FirstName', 'LastName', 'FullName', 'Email', 'Department', 'JobTitle', 'Manager'] as const;
export const ASSET_FIXED_VARIABLES = ['Status', 'AssetLink', 'Today'] as const;

/** Every variable name, for the editors to list and the document check to accept. */
export async function assetVariableNames(): Promise<string[]> {
  const keys = (await listColumns()).filter((c) => c.format !== 'person').map((c) => c.key);
  return [...new Set([...keys, 'Company', ...PERSON_VARIABLES, ...ASSET_FIXED_VARIABLES])];
}

const today = () => new Date().toISOString().slice(0, 10);

export async function assetVariables(
  asset: Pick<AssetRow, 'id' | 'field_values' | 'status_id' | 'assigned_to'> & Partial<Pick<AssetListItem, 'status_name'>>,
  person?: UserRow | null,
): Promise<Record<string, string>> {
  const who = person === undefined ? (asset.assigned_to ? await findUserById(asset.assigned_to) : undefined) : person ?? undefined;
  const manager = who?.manager_id ? await findUserById(who.manager_id) : undefined;
  const status = asset.status_name ?? (await listStatuses()).find((s) => s.id === asset.status_id)?.name ?? '';
  const values: Record<string, string> = {};
  for (const column of await listColumns()) {
    if (column.format !== 'person') values[column.key] = asset.field_values[column.key] ?? '';
  }
  return {
    ...values,
    Company: asset.field_values.Company || who?.company || '',
    FirstName: who?.first_name || who?.display_name || '',
    LastName: who?.last_name || '',
    FullName: who?.display_name || '',
    Email: who?.email || '',
    Department: who?.department || '',
    JobTitle: who?.job_title || '',
    Manager: manager?.display_name || '',
    Status: status,
    AssetLink: config.publicOrigin + '/inventory/' + asset.id,
    Today: today(),
  };
}

/** Invented values, for a preview: a real asset would differ for every reader. */
export function sampleAssetVariables(): Record<string, string> {
  return {
    Model: 'Latitude 7440',
    SerialNumber: 'DL-7440-01',
    DateBought: '2025-03-14',
    Imei: '',
    PoNumber: 'PO-2025-118',
    Type: 'Laptop',
    Vendor: 'Dell',
    Company: 'Contoso',
    Comment: '',
    FirstName: 'John',
    LastName: 'Smith',
    FullName: 'John Smith',
    Email: 'john.smith@example.com',
    Department: 'Finance',
    JobTitle: 'Accountant',
    Manager: 'Emma Wilson',
    Status: 'Assigned',
    AssetLink: config.publicOrigin + '/inventory/example',
    Today: today(),
  };
}
