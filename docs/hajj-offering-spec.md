# H0 — Hajj OfferingType spec

Migration of the 9 hajj programs from `CompanyAIConfig.catalog.hajjPrograms` (frozen
JSON) into an `OfferingType` named **حج**, mirroring the Umrah Offerings path.

Scope of this document: the `fieldDefs` contract, the flattening scheme, and which
keys stay as opaque JSON. It specifies **H2 (populate alongside) only** — nothing
reads these rows until H3.

**Goal, stated plainly:** a wrong **price** must be fixable from `/admin/offerings` in
seconds. This is not full WYSIWYG editing of hajj program prose.

---

## 1. Settled decisions

| Decision | Value |
|---|---|
| ISO dates | Add `startDateISO` + `endDateISO` **alongside** the existing Arabic strings |
| Expiry semantics | Hajj expiry uses the **END** date (a program mid-season must not vanish on departure day) |
| Flattening | **Partial** — flatten only what changes season to season: price, per-section hotel names, date fields |
| Long-form content | `highlights` and descriptive prose stay as stored JSON |
| Category | Explicit `category` field. **Never parse the name.** |
| Price | **Optional** — 2 of 9 programs have `pricePerPerson: null` |
| Display order | **Computed** (category group, then price). Do **not** switch to `sortOrder`. |

---

## 2. What flattens vs what stays JSON

### 2.1 Flattened — editable in `/admin/offerings`

Changes season to season, or needed for sorting/filtering/gating.

| key | role | inputType | required | showInList | notes |
|---|---|---|---|---|---|
| `id` | — | text | true | false | preserves original `hajj-p1-bari-2027` id |
| `name` | `title` | text | true | true | |
| `category` | — | text | true | true | `economic` \| `five_star` \| `kadan` \| `special` |
| `pricePerPerson` | `price` | number | **false** | true | null ⇒ "سعر خاص — للتواصل مع المبيعات" |
| `discountedPrice` | `price-discounted` | number | false | true | 1 of 9 |
| `discountAmount` | — | number | false | false | 1 of 9 |
| `discountNote` | — | text | false | false | 1 of 9 |
| `startDateISO` | `start-date` | date | false | true | **derived** — see §4 |
| `endDateISO` | `end-date` | date | false | false | **derived** — drives expiry |
| `ticketType` | — | text | true | false | العبّارة / الطيران — appears in the price line |
| `transportationType` | — | text | true | false | بري / جوي |
| `haramainTrain` | — | checkbox | false | false | |
| `includesAirTicket` | `flight-included` | checkbox | false | false | false on all 9 |
| `medinaHotel` | `location` | text | false | true | |
| `medinaDateHijri` | — | text | false | false | |
| `medinaDateGregorian` | — | text | false | false | |
| `aziziyahHotel` | `location-2` | text | false | false | |
| `aziziyahDateHijri` | — | text | false | false | |
| `aziziyahDateGregorian` | — | text | false | false | |
| `makkahHotel` | `location-3` | text | false | false | from `makkahPreSeason` |
| `makkahDateHijri` | — | text | false | false | |
| `makkahDateGregorian` | — | text | false | false | |
| `tahseenHotel` | `location-4` | text | false | false | |
| `tahseenDateHijri` | — | text | false | false | |
| `tahseenDateGregorian` | — | text | false | false | |

25 flattened keys (plus the 2 JSON keys in §2.2, which have no `fieldDef` entry).

### 2.2 Stored JSON — preserved verbatim, not admin-editable

`FieldDef.inputType` has no object/array variant, so these live in two JSON keys with
`role: null` and **no fieldDef entry** (the admin form renders only declared fields, so
they are carried untouched through a PATCH round-trip):

**`sectionsJson`** — the non-flattened part of each `HajjProgramSection`:

```jsonc
{
  "medina":          { "roomType": "رباعي/خماسي", "meals": "…", "note": null, "durationDays": null },
  "aziziyah":        { "roomType": "رباعي/خماسي", "meals": "…", "note": "أقل مدة إقامة في العزيزية" },
  "makkahPreSeason": { "meals": "إفطار وعشاء" },
  "tahseen":         { "meals": "إفطار أوبن بوفيه", "durationDays": 6 }
}
```

**`contentJson`** — long-form / structural prose:

```jsonc
{
  "highlights":     ["…", "…"],      // 0–7 items
  "scholarNote":    "حج قِران — …",   // 1 of 9
  "subLevels":      null,             // in the interface, absent from all 9
  "transitToMecca": "الانتقال إلى مكة بالباص…",  // 5 of 9
  "arafat":         "مخيمات اقتصادية",           // 4 of 9
  "mina":           "مخيمات منى المطورة",        // 4 of 9
  "manasikhMeals":  "المناسك شامل ٣ وجبات"       // 3 of 9
}
```

### 2.3 Section presence rule

`renderHajjProgram` branches on `if (p.medina)`, `if (p.tahseen)`, etc. After
flattening, **presence ⇔ the section's hotel key is a non-empty string**.

Verified across all 9 programs: every section that exists has a non-empty `hotel`
(medina 6/6, aziziyah 2/2, makkahPreSeason 4/4, tahseen 2/2). The H3 reconstructor must
use this rule and must not emit an empty section object.

---

## 3. Category assignment

Assigned **once at migration** to reproduce today's runtime classification exactly, then
never re-derived from the name.

Current logic ([dynamic-catalog-builder.ts:302-313](../src/agent/prompts/dynamic-catalog-builder.ts#L302)):
`special` wins whenever there is no price, regardless of name — so two programs whose
names say اقتصادي are **not** `economic`.

| # | Program | price | category |
|---|---|---|---|
| 1 | برنامج الحج البري | 239,000 | `economic` |
| 2 | برنامج حج اقتصادي - تحسين ٥ نجوم | 255,000 | `economic` ¹ |
| 3 | برنامج أطول فترة تحسين ١٤ يوم - اقتصادي | 262,000 | `economic` |
| 4 | برنامج ٥ نجوم أ | 520,000 | `five_star` |
| 5 | برنامج اقتصادي أطول فترة تحسين ١٤ يوم | **null** | `special` ² |
| 6 | برنامج ٥ نجوم ب | 495,000 | `five_star` |
| 7 | برنامج أبراج كدانة - المستوى الكامل | 650,000 | `kadan` |
| 8 | برنامج أبراج كدانة - مستوى سريع | 595,000 → 550,000 | `kadan` |
| 9 | اقتصادي تحسين - أطول فترة تحسين بين الشركات | **null** | `special` ² |

¹ Contains `٥ نجوم` but `is5Star` requires `startsWith('برنامج ٥ نجوم')`/`startsWith('٥ نجوم')`
or `includes('خمس نجوم')` — none match, so it classifies as economic today. Preserved as-is.
² Name says اقتصادي, but no price ⇒ `special` under current logic. Preserved as-is.

**This table is behaviour-preserving, not behaviour-correcting.** If ¹ or ² are wrong
from a business standpoint, fixing them changes customer-visible output and must be a
separate, deliberate change after the byte-identical proof — not folded into H2.

---

## 4. Derived ISO dates

Neither ISO field exists in the source. Both are computed at migration:

- `startDateISO` = earliest section start
- `endDateISO` = latest section end

Parsed from the Gregorian range strings (`"٧-١٠ مايو ٢٠٢٧م"` → 2027-05-07 … 2027-05-10).

| # | sections | startDateISO | endDateISO |
|---|---|---|---|
| 1 | medina, aziziyah, tahseen | 2027-05-07 | 2027-05-26 |
| 2 | medina, aziziyah, tahseen | 2027-05-08 | 2027-05-26 |
| 3 | **none** | 2027-05-07 ᶠ | 2027-05-26 ᶠ |
| 4 | medina, makkahPreSeason | 2027-05-07 | 2027-05-20 |
| 5 | **none** | 2027-05-07 ᶠ | 2027-05-26 ᶠ |
| 6 | medina, makkahPreSeason | 2027-05-07 | 2027-05-20 |
| 7 | medina, makkahPreSeason | 2027-05-07 | 2027-05-20 |
| 8 | medina, makkahPreSeason | 2027-05-10 | 2027-05-20 |
| 9 | **none** | 2027-05-07 ᶠ | 2027-05-26 ᶠ |

ᶠ **Season-bounds fallback.** Programs 3, 5 and 9 carry no dates anywhere — they are
highlights-only records. They fall back to the season bounds from
`industryData.hajjHijriDates`: ١ ذو الحجة = ٧ مايو ٢٠٢٧ → ٢٠ ذو الحجة = ٢٦ مايو ٢٠٢٧.

Rationale: with END-date expiry this is the conservative choice — those three stay
visible for the whole season rather than disappearing early. **It is an assumption, not
source data**, and is flagged here because it is the one place H2 invents a value.

The Arabic strings remain authoritative for display. The ISO fields are used **only**
for sorting, filtering and the freshness gate — never rendered to customers.

---

## 5. Ordering — two different orders, do not conflate them

> **Corrected after H4.** An earlier draft of this section said the raw array should be
> pre-sorted by category+price and that `sortOrder` was cosmetic. That is wrong and the
> golden diff caught it: it renumbered `hajjProgramDetails` and the system-prompt hajj
> section. Both orders below are load-bearing.

### 5a. Storage / raw-array order = **source authoring order**

`Offering.sortOrder` = the program's index in `catalog.hajjPrograms`. The bridge maps
rows in that order and **must not re-sort**. Two surfaces render the raw array exactly
as given:

- `buildHajjProgramDetailsArray` → `hajjProgramDetails` (the chunked 3-per-message path)
- `buildHajjCatalogFromDB` → the hajj block of the system prompt

### 5b. Customer-facing display order = **computed inside the overview builders**

Overview order is `[economic, five_star, kadan, special]`, each group sorted ascending
by `pricePerPerson`; `special` keeps source order. Programs are numbered ١…٩ across the
whole list, and **customers reply with that number** to select one.

Resulting order (this is the contract H4 must prove byte-identical):

| ١ | ٢ | ٣ | ٤ | ٥ | ٦ | ٧ | ٨ | ٩ |
|---|---|---|---|---|---|---|---|---|
| البري | حج اقتصادي تحسين ٥ نجوم | أطول فترة ١٤ يوم اقتصادي | ٥ نجوم ب | ٥ نجوم أ | كدانة سريع | كدانة كامل | اقتصادي أطول ١٤ | اقتصادي تحسين |
| 239k | 255k | 262k | 495k | 520k | 595k | 650k | — | — |

`buildHajjOverviewMessage` and `buildHajjCategoryPrograms` re-filter and re-sort the raw
array themselves, using `categoryRank` (`economic`=0, `five_star`=1, `kadan`=2,
`special`=3) then ascending price. **The bridge must not reproduce this** — it happens
downstream, and doing it twice renumbers 5a.

Note those builders still derive the category from the **program name** at runtime
(`is5Star` / `isKadan` / `hasPrice`). The stored `category` field is therefore **not yet
consumed** — it is populated for the admin UI and for a later, deliberate switch away
from name-parsing. Leaving classification untouched is what makes H4's byte-identical
result meaningful.

---

## 6. Out of scope for H2

- No reads. `catalog-loader.ts` still queries only `name: 'عمرة'`.
- `catalog.hajjPrograms` is **not modified or deleted** — it remains the live source.
- No bridge (`offeringToRawHajjProgram`), no builder signature change — that is H3.
- Freshness gate stays Umrah-only — that is H5.
- `autoName()` in the dashboard hardcodes the literal `عمرة`; a blank hajj title would
  generate a wrong name. Not hit in H2 (all 9 titles are populated) — must be fixed
  before hajj rows are editable in admin.
