/**
 * Time zones as Windows lists them: one entry per region, naming its cities,
 * with the offset in front - "(UTC+01:00) Belgrade, Bratislava, Budapest,
 * Ljubljana, Prague" - rather than the 400-odd single cities the IANA
 * database has. Each entry stands for one IANA zone, which is what is stored
 * and what the date arithmetic uses.
 *
 * The offset shown is the zone's **standard** offset, as Windows shows it,
 * worked out from the zone's own rules (the smaller of January and July,
 * since daylight saving only ever adds), so it cannot drift from the data.
 */

const REGIONS: readonly [iana: string, label: string][] = [
  ['Etc/GMT+12', 'International Date Line West'],
  ['Etc/GMT+11', 'Coordinated Universal Time-11'],
  ['Pacific/Honolulu', 'Hawaii'],
  ['America/Anchorage', 'Alaska'],
  ['America/Los_Angeles', 'Pacific Time (US & Canada)'],
  ['America/Phoenix', 'Arizona'],
  ['America/Denver', 'Mountain Time (US & Canada)'],
  ['America/Guatemala', 'Central America'],
  ['America/Chicago', 'Central Time (US & Canada)'],
  ['America/Mexico_City', 'Guadalajara, Mexico City, Monterrey'],
  ['America/Regina', 'Saskatchewan'],
  ['America/Bogota', 'Bogota, Lima, Quito, Rio Branco'],
  ['America/New_York', 'Eastern Time (US & Canada)'],
  ['America/Halifax', 'Atlantic Time (Canada)'],
  ['America/Caracas', 'Caracas'],
  ['America/Santiago', 'Santiago'],
  ['America/St_Johns', 'Newfoundland'],
  ['America/Sao_Paulo', 'Brasilia'],
  ['America/Argentina/Buenos_Aires', 'City of Buenos Aires'],
  ['Etc/GMT+2', 'Coordinated Universal Time-02'],
  ['Atlantic/Azores', 'Azores'],
  ['Atlantic/Cape_Verde', 'Cabo Verde Is.'],
  ['UTC', 'Coordinated Universal Time'],
  ['Europe/London', 'Dublin, Edinburgh, Lisbon, London'],
  ['Atlantic/Reykjavik', 'Monrovia, Reykjavik'],
  ['Europe/Berlin', 'Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna'],
  ['Europe/Prague', 'Belgrade, Bratislava, Budapest, Ljubljana, Prague'],
  ['Europe/Paris', 'Brussels, Copenhagen, Madrid, Paris'],
  ['Europe/Warsaw', 'Sarajevo, Skopje, Warsaw, Zagreb'],
  ['Africa/Lagos', 'West Central Africa'],
  ['Europe/Bucharest', 'Athens, Bucharest'],
  ['Africa/Cairo', 'Cairo'],
  ['Europe/Helsinki', 'Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius'],
  ['Asia/Jerusalem', 'Jerusalem'],
  ['Africa/Johannesburg', 'Harare, Pretoria'],
  ['Europe/Istanbul', 'Istanbul'],
  ['Asia/Riyadh', 'Kuwait, Riyadh'],
  ['Europe/Moscow', 'Moscow, St. Petersburg'],
  ['Africa/Nairobi', 'Nairobi'],
  ['Asia/Tehran', 'Tehran'],
  ['Asia/Dubai', 'Abu Dhabi, Muscat'],
  ['Asia/Baku', 'Baku'],
  ['Asia/Kabul', 'Kabul'],
  ['Asia/Karachi', 'Islamabad, Karachi'],
  ['Asia/Tashkent', 'Ashgabat, Tashkent'],
  ['Asia/Kolkata', 'Chennai, Kolkata, Mumbai, New Delhi'],
  ['Asia/Kathmandu', 'Kathmandu'],
  ['Asia/Almaty', 'Astana'],
  ['Asia/Dhaka', 'Dhaka'],
  ['Asia/Yangon', 'Yangon (Rangoon)'],
  ['Asia/Bangkok', 'Bangkok, Hanoi, Jakarta'],
  ['Asia/Shanghai', 'Beijing, Chongqing, Hong Kong, Urumqi'],
  ['Asia/Singapore', 'Kuala Lumpur, Singapore'],
  ['Australia/Perth', 'Perth'],
  ['Asia/Taipei', 'Taipei'],
  ['Asia/Tokyo', 'Osaka, Sapporo, Tokyo'],
  ['Asia/Seoul', 'Seoul'],
  ['Australia/Adelaide', 'Adelaide'],
  ['Australia/Darwin', 'Darwin'],
  ['Australia/Brisbane', 'Brisbane'],
  ['Australia/Sydney', 'Canberra, Melbourne, Sydney'],
  ['Australia/Hobart', 'Hobart'],
  ['Pacific/Port_Moresby', 'Guam, Port Moresby'],
  ['Pacific/Guadalcanal', 'Solomon Is., New Caledonia'],
  ['Pacific/Auckland', 'Auckland, Wellington'],
  ['Pacific/Fiji', 'Fiji'],
  ['Pacific/Tongatapu', "Nuku'alofa"],
  ['Pacific/Kiritimati', 'Kiritimati Island'],
];

export interface TimeZoneOption {
  /** The IANA zone stored and used. */
  value: string;
  /** "(UTC+01:00) Belgrade, Bratislava, ..." */
  label: string;
  /** Standard offset in minutes, for ordering. */
  offset: number;
}

function offsetAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The offset without daylight saving: the smaller of midwinter and midsummer. */
function standardOffset(timeZone: string): number {
  const year = new Date().getUTCFullYear();
  return Math.min(
    offsetAt(new Date(Date.UTC(year, 0, 15)), timeZone),
    offsetAt(new Date(Date.UTC(year, 6, 15)), timeZone),
  );
}

function prefix(offset: number, iana: string): string {
  // As Windows writes it: bare (UTC) for UTC itself, (UTC+00:00) for London.
  if (iana === 'UTC') return '(UTC)';
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    '(UTC' + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0') + ')'
  );
}

function known(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The list for a picker, west to east. `current` is added as its own entry
 * if it is a zone the list does not carry - one set before this list
 * existed, say - so saving the page never silently changes it.
 */
export function timeZoneOptions(current?: string): TimeZoneOption[] {
  const entries = REGIONS.filter(([iana]) => known(iana));
  if (current && known(current) && !entries.some(([iana]) => iana === current)) {
    entries.push([current, current.replace(/_/g, ' ')]);
  }
  return entries
    .map(([value, name]) => {
      const offset = standardOffset(value);
      return { value, offset, label: prefix(offset, value) + ' ' + name };
    })
    .sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label));
}
