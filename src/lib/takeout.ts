// Parses the subscriptions.csv from Google Takeout
// (Takeout > YouTube and YouTube Music > subscriptions), so someone with an
// existing account can seed hundreds of channels in one drop instead of
// following them one page at a time.
//
// Columns are "Channel Id, Channel Url, Channel Title" in English exports, but
// the headers are localised — so we locate the id by its shape (UC + 22 chars),
// not by its column name.

export interface TakeoutChannel {
  id: string;
  title: string;
}

const CHANNEL_ID = /^UC[\w-]{22}$/;

/** Split one CSV line, honouring quoted fields (titles contain commas). */
function splitRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

export function parseTakeoutCsv(csv: string): TakeoutChannel[] {
  const channels: TakeoutChannel[] = [];
  const seen = new Set<string>();

  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = splitRow(line);

    const idIndex = fields.findIndex((f) => CHANNEL_ID.test(f));
    if (idIndex === -1) continue; // header row, or a row without a usable id
    const id = fields[idIndex];
    if (seen.has(id)) continue;
    seen.add(id);

    // The title is the last non-empty field that is neither the id nor a URL.
    const title =
      [...fields]
        .reverse()
        .find((f, i) => f && fields.length - 1 - i !== idIndex && !/^https?:\/\//.test(f)) ?? id;

    channels.push({ id, title });
  }
  return channels;
}
