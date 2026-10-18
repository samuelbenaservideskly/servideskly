# Custom languages, translated by an AI

Asked for by the owner on 16 Oct 2026. **Designed, not built** - the design
is here because the feature is three or four sessions of work and the shape
of it decides things that are expensive to change later.

The owner's words, in order:

- Under Locale, add a **Custom language**.
- It is a **markdown document** with the context of each button and text,
  plus **a prompt to copy** for an AI to translate it.
- You paste the markdown into an AI, say "translate this to X", and paste
  the answer back.
- A language can be **scoped to a group or to an email domain**.
- Adding one adds a sub-setting under **Other settings - Notifications -
  <language name>**, e.g. CZ; the name is **exactly two characters**.
- Those notification templates are **automatically translated from the
  default ones**.
- **Any new feature must be added to the translator markdown automatically.**
- Language is **detected from the browser, assigned by group, or excluded
  by group**; a person can **choose their own** on their profile.

---

## Why this is not a small feature

Every string a reader sees is written into a `.ejs` file today - about 200
views, several thousand strings. Nothing in the application can name a
string, so nothing can translate one. The markdown document the owner wants
is the *easy* half; the hard half is that every one of those strings has to
become something addressable.

Three ways to get there, and only one of them is honest:

| | How | Cost | Why not |
| --- | --- | --- | --- |
| A | Translate the rendered HTML at send time | A text pass over every response | It would translate ticket titles, people's names and an administrator's own HTML. Unfixable. |
| B | Key every string by hand (`t('tickets.new')`) | Weeks, and every new string is a second edit somebody forgets | The owner's last requirement - "any new feature should be automatically added" - is exactly what hand-keying fails at |
| C | **Extract at build time, key by content** | A script walks the views, lifts every literal, and gives each a stable id from its own text and its file | A new string appears in the catalogue the moment it is written, because the catalogue is generated, not maintained |

**C is the one to build.** It is also the only one that satisfies "any new
feature should be automatically added to this translator markdown": the
markdown is a build artefact, not a document somebody keeps up to date.

---

## The shape

### 1. The catalogue (`scripts/strings.ts`, generated)

A script walks `views/**/*.ejs` and the handful of places that hold reader
text in code (`STATUS_LABELS`, `PRIORITY_LABELS`, flash messages, the
notification seeds), and writes `src/i18n/strings.json`:

```json
{
  "tickets.index.raise": { "text": "Raise a ticket", "where": "views/tickets/index.ejs", "context": "Button above the ticket list" }
}
```

- The **id** is the file path plus a hash of the text, so it is stable while
  the text is, and a changed string is a new id - which is what should
  happen: a changed English string invalidates its translation.
- The **context** line is what makes an AI translation good rather than
  literal, and it is the one thing the script cannot infer. Take it from an
  EJS comment above the string where one exists, and otherwise from the
  file and the element - "Button", "Heading", "Table column".
- `npm run strings` regenerates it; `npm run verify` fails when it is stale,
  the same way `pg-schema.test.ts` fails when the schema drifts. **That is
  the "automatically added" requirement**, and it is a check rather than a
  promise.

### 2. The markdown and the prompt (Settings - Customisation - Locale)

A download, generated from the catalogue:

````markdown
# Translate this helpdesk into <language>

You are translating the interface of a service desk application...
[the prompt, written once, with the rules: keep {{placeholders}} exactly,
keep the two-letter ids, do not translate a reference like INC-000123,
prefer the formal register, keep it short enough for a button]

| id | context | English | Your translation |
| --- | --- | --- | --- |
| tickets.index.raise | Button above the ticket list | Raise a ticket | |
````

The owner pastes it into an AI, gets the table back, and uploads it. The
importer reads the table, ignores rows whose id it does not know (a string
removed since), and reports how many of the catalogue's strings are
covered - "412 of 1,180 translated" is a useful thing to see.

### 3. Serving a language

`res.locals.t(id, fallback)` in a middleware, backed by one in-memory map
per language (the settings cache pattern). The views call `t()` where the
extractor found a string - **the extractor rewrites them**, which is a
single large mechanical commit, not a hand edit.

A missing translation renders the English, always. A language is never a
reason for a page to be empty.

### 4. Which language a reader gets

In order, first answer wins:

1. **Their own choice**, on the profile page (a language, or "Follow my
   browser") - asked for 16 Oct 2026.
2. **A group assignment**: a user group may name a language, and a group
   may be excluded from one.
3. **The email domain**, for somebody with no group.
4. **The browser** (`Accept-Language`), when the service desk allows it.
5. English.

The first and the last are the ones that must never fail.

### 5. Notifications

Each language gets its own set of notification rows - the owner's "Other
settings - Notifications - CZ". They are **copied from the English ones at
creation** and then edited freely, which is the same rule as everything
else here: generated once, owned afterwards.

Sending picks the recipient's language by the rules above, and falls back
to the English row when that language has none. A notification is the one
place where a half-translated message is worse than an English one, so the
fallback is per row rather than per string.

---

## Decided (owner, 16 Oct 2026)

1. **The tag is `cs-CZ`** - language and region, which is also what a
   browser sends in `Accept-Language`, so matching needs no translation
   table. Matching is longest-first: `cs-CZ` beats `cs`, and `cs` answers a
   browser asking for `cs-SK`. The two-character name the owner first asked
   for is the **label** on the notification sub-tab (CZ), which is theirs to
   type and need not be the tag.
2. **The administration pages are translated too.** It is most of the
   catalogue, and the owner's answer was yes - a service desk run in Czech
   is run in Czech. The extractor does not care how many strings there are;
   the cost is in the review, not the code.
3. **Only built-in text is translated.** A template name, a portal page, a
   dashboard design and anything else an administrator wrote stays exactly
   as written - it is their text, in whatever language they chose, and
   nothing here second-guesses it. **Notifications are the exception**: each
   language gets its own set of rows, copied from the English ones and
   edited freely.

---

## Checks

The extractor needs tests of its own (ids are stable across a reformat, a
changed string gets a new id, a placeholder survives a round trip), and the
language resolution needs the five rules above as five tests.
