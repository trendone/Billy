# Konzept & Roadmap – Ressourcenplanung „Billy"

> Stand: 2026-06-25 · Autor: erarbeitet mit Claude Code
> Zielbild: Aus dem heutigen wochenbasierten Ressourcen-Tool ein leichtes
> Projektmanagement- und Planungssystem mit Anbindung an **Zoho CRM** und
> **Personio** entwickeln – auf einer **soliden, sicheren, relationalen
> Architektur (Supabase / Postgres)**, als **Neuaufbau** (keine Migration).

---

## 1. Ausgangslage (heutiger Stand, v1.0)

Die App ist heute eine statische Web-App (Vanilla JS, ES-Module), gehostet auf
**GitHub Pages**, mit **Firebase Firestore** als Backend. Der gesamte Zustand
liegt in **einem** Dokument `app/state`:

| Entität | Felder (heute) |
|---|---|
| `employees` | `id, name, weeklyHours, hoursPeriods[]` |
| `projects` | `id, name, color, budgetDays, isVacation` |
| `tasks` (Buchungen) | `id, projectId, employeeId, startDate, endDate, budget (0.5\|1), note` |

**Was die App schon besser kann als Excel:**
- Echtzeit-Sync über mehrere Nutzer
- Kapazitätslogik: Wochenstunden + abweichende Perioden
- System-Projekte „Urlaub / Krank / Admin" als nicht-buchbare Zeit
- Automatische Auslastungs- und Budget-Auswertung (`auswertung.html`)

**Warum wir die Plattform wechseln (bewusste Entscheidung):**
1. **Roadmap ist relational** – Profitabilität, Controlling, Soll/Ist und
   Forecast brauchen Joins/Aggregationen über Projekte × Pakete × Buchungen ×
   Deals × Tagessätze. Eine Dokument-DB (Firestore) ist darin schwach.
2. **Ein-Dokument-Modell** skaliert nicht (1-MB-Limit, Überschreib-Risiko).
3. **Sicherheit** – heutiges Passwort ist nur ein Client-Gate; API-Key liegt im
   öffentlichen Quelltext. Mit CRM-/HR-Daten brauchen wir echte Auth + feingranulare
   Zugriffsregeln.
4. **Integrationen** (Zoho/Personio/Mail) brauchen Server-Logik, Secrets und
   geplante Jobs – clientseitig nicht machbar.

**Entscheidung:** **Neuaufbau** auf **Supabase** (managed Postgres + Auth +
Realtime + Row-Level-Security + Edge Functions + `pg_cron`). Die App wird aktuell
**noch nicht produktiv genutzt** → **keine Migration** der Firestore-Daten,
sondern eine **kontrollierte Erst-Befüllung aus der Excel** (Abschnitt 5).
Begründung der Stack-Wahl siehe Abschnitt 10.

---

## 2. Zielbild

Drei Ausbaurichtungen, die aufeinander aufbauen:

1. **Leichtes Projektmanagement** – Projekte in *Arbeitspakete* und *Meilensteine*
   gliedern, Soll/Ist pro Paket, Rechnungs-/Deadline-Übersicht.
2. **Integrationen** – *Zoho CRM* (Aufträge & Pipeline) und *Personio*
   (Abwesenheiten) automatisch spiegeln, doppelte Pflege entfällt.
3. **Controlling** – Profitabilität pro Projekt/Kunde, Plan-vs-Ist, Forecast.

Leitprinzipien:
- **Quellsysteme bleiben führend** (Personio = Abwesenheiten/Stammdaten,
  Zoho = Aufträge/Umsatz). Wir spiegeln einseitig (read-only) hinein.
- **Sicher von Anfang an**: echte Authentifizierung + Row-Level-Security ab v1.
- **Saubere Daten von Anfang an**: validierter, gestufter Erst-Import (Abschnitt 5).
- **Schlank bleiben**: kein Feature ohne klaren Mehrwert gegenüber der Excel-Liste.

---

## 3. Datenmodell (Postgres)

Relationales Schema – ersetzt das heutige Ein-Dokument-Modell. UUID-Primärschlüssel,
Fremdschlüssel mit `on delete`-Regeln, alle Tabellen mit RLS (Abschnitt 4.6).

### 3.1 Stammdaten
```sql
employees (
  id            uuid pk,
  name          text not null,
  email         text unique,        -- Mapping-Schlüssel (Personio/SSO)
  weekly_hours  numeric not null,
  active        bool default true
)

employee_hours_periods (            -- abweichende Arbeitszeiten (heute hoursPeriods[])
  id           uuid pk,
  employee_id  uuid references employees on delete cascade,
  valid_from   date not null,
  weekly_hours numeric not null
)
```

### 3.2 Projekte (angereichert)
```sql
projects (
  id          uuid pk,
  name        text not null,
  color       text,
  status      text default 'aktiv',   -- akquise|aktiv|pausiert|abgeschlossen
  client      text,                    -- Kunde (aus Zoho Account)
  start_date  date,
  end_date    date,
  budget_days numeric,
  budget_eur  numeric,                 -- aus Zoho Amount
  is_system   bool default false,      -- System-Kategorie (s. u.)
  source      text default 'manuell',  -- manuell|zoho
  external_id text,                    -- Zoho Deal-ID (Idempotenz)
  probability int                      -- nur Pipeline-Deals: Abschluss-%
)
```
**System-Kategorien** (`is_system = true`): **Urlaub, Krank, Admin, Frei**.
Sie sind nicht-buchbare Zeit, **kein** Teil des Projektpools und werden in
Projekt-Reports/Budget-Auswertungen ausgeklammert. „Frei" ist die Kategorie für
freie Tage (s. Abschnitt 5.4). Feiertage sind **keine** Daten, sondern werden
automatisch berechnet (Abschnitt 5.4).

### 3.3 Arbeitspakete (PM-Kern)
```sql
workpackages (
  id          uuid pk,
  project_id  uuid references projects on delete cascade,
  title       text not null,
  budget_days numeric,
  start_date  date, end_date date,
  assignee_id uuid references employees,
  done        bool default false
)
```

### 3.4 Meilensteine (Rechnungslogik)
```sql
milestones (
  id             uuid pk,
  project_id     uuid references projects on delete cascade,
  title          text not null,
  due_date       date,
  amount_eur     numeric,
  invoice_status text default 'offen'   -- offen|gestellt|bezahlt
)
```

### 3.5 Buchungen (heute `tasks`)
```sql
bookings (
  id             uuid pk,
  project_id     uuid references projects on delete cascade,
  workpackage_id uuid references workpackages on delete set null,
  employee_id    uuid references employees on delete cascade,
  start_date     date not null,
  end_date       date not null,
  budget         numeric not null,      -- 0.5 | 1
  note           text,
  locked         bool default false,    -- aus Personio gespiegelt (nicht editierbar)
  source         text default 'manuell',-- manuell|personio
  external_id    text                   -- Personio-Abwesenheits-ID (Idempotenz)
)
```

### 3.6 Ist-Zeiterfassung (optional, später)
```sql
actuals (
  id          uuid pk,
  booking_id  uuid references bookings on delete cascade,
  employee_id uuid references employees,
  date        date not null,
  hours       numeric not null
)
```
→ Buchung = Soll, `actuals` = Ist. Größter Glaubwürdigkeits-Gewinn fürs Controlling.

---

## 4. Architektur (Supabase)

### 4.1 Komponenten
- **Postgres** (Supabase managed) – die relationale Datenbasis aus Abschnitt 3.
- **Supabase Auth** – echte Logins, SSO für @trendone.com (Microsoft/Google).
- **Realtime** – ersetzt das heutige `onSnapshot`; Tabellen-Änderungen live an Clients.
- **Row-Level-Security (RLS)** – Zugriffsregeln direkt in der DB (Abschnitt 4.6).
- **Edge Functions** (Deno/TypeScript) – die Integrations-Brücke (Secrets,
  OAuth, Webhooks, ausgehende Mails) **und** der Erst-Import (Abschnitt 5).
- **`pg_cron`** – geplante Jobs (Sync, Digest).
- **Secrets/Vault** – Zoho/Personio-Credentials, nie im Frontend.
- **Frontend** – bleibt statisch (GitHub Pages oder Vercel), nutzt
  `@supabase/supabase-js` statt des Firebase-SDK.

### 4.2 Übersichtsdiagramm
```
┌────────────┐  pull/webhook   ┌──────────────────────────────┐
│  Zoho CRM  │ ──────────────▶ │          Supabase            │
└────────────┘                 │  ┌────────────────────────┐  │
┌────────────┐  pull           │  │ Edge Functions         │  │    ┌────────────┐
│  Personio  │ ──────────────▶ │  │  sync-zoho     (cron)  │  │    │  Postgres  │
└────────────┘                 │  │  sync-personio (cron)  │  │ ─▶ │  + RLS     │
┌────────────┐  send           │  │  zoho-webhook  (http)  │  │    └─────┬──────┘
│ Mail/Teams │ ◀────────────── │  │  send-digest   (cron)  │  │          │ Realtime
└────────────┘                 │  └────────────────────────┘  │          ▼
                               │   Auth (SSO @trendone)       │   ┌────────────┐
                               │   Vault (Secrets)            │   │  Web-App   │
                               │   pg_cron (Scheduler)        │   │ (Pages/    │
                               └──────────────────────────────┘   │  Vercel)   │
                                                                   └────────────┘
```

### 4.3 Konnektor Personio (read-only Spiegelung)
- **Auth**: Client-ID + Secret → kurzlebiger Bearer-Token (Refresh in der Function).
- **Quelle**: Abwesenheits-Endpoint (Time-offs) – Mitarbeiter, Typ
  (Urlaub/Krank/…), Start/Ende, **Halbtags-Flag**, Status.
- **Mapping-Schlüssel**: **E-Mail** (`employees.email` ↔ Personio-E-Mail) – stabil,
  nicht der Name. Erster Lauf erzeugt einen Mapping-Report für nicht zugeordnete MA.
- **Ergebnis**: genehmigte Abwesenheiten → `bookings` auf System-Kategorie
  Urlaub/Krank, `locked = true`, `source = 'personio'`, Idempotenz über
  `external_id`. Halbtag → `budget 0.5`.

### 4.4 Konnektor Zoho CRM (Deals/Potenziale)
- **Auth**: OAuth 2.0 (Self-Client), Refresh-Token im Vault, Access-Token (1 h)
  wird in der Function erneuert. Data-Center-Domain beachten (.eu/.com).
- **Feld-Mapping Deal → `projects`:**

  | Zoho-Feld | Spalte |
  |---|---|
  | Deal Name | `name` |
  | Account Name | `client` |
  | Amount | `budget_eur` |
  | Closing Date | `end_date` / Meilenstein |
  | Stage | `status` |
  | Probability | `probability` |
  | Deal-ID | `external_id` (Idempotenz) |

- **Zwei Modi**: `sync-zoho` (cron, Pull) + `zoho-webhook` (Zoho-Workflow
  „Closed Won" → sofortiges Anlegen).
- **Pipeline-Forecast (Killer-Feature)**: offene Deals als **vorläufige, weiche**
  Ressourcennachfrage (schraffiert, nach `probability` gewichtet).

### 4.5 Ausgehend: Mail/Teams-Erinnerungen
`send-digest` (cron) wertet Meilensteine + Auslastung aus → fällige/überfällige
Rechnungen, Überbuchungen, Deadlines. Kanal: Transaktionsmail oder Teams-Webhook.

### 4.6 Sicherheit & Datenschutz
- **Authentifizierung**: Supabase Auth, SSO auf @trendone.com beschränkt.
- **Row-Level-Security** auf allen Tabellen:
  - Lesen/Schreiben nur für authentifizierte @trendone-Nutzer.
  - Integrations-Daten (`source` = zoho/personio, `locked`) nur durch Edge
    Functions (Service-Role) schreibbar, im Client read-only.
- **Rollen**: Betrachter (read-only) · Planer · Admin – als RLS-Policies.
- **Secrets** ausschließlich im Vault; Frontend kennt nur den öffentlichen
  anon-Key (mit RLS ungefährlich).
- **DSGVO**: Personio-Daten zweckgebunden + minimal; Rechtsgrundlage/AV-Vertrag mit HR.

---

## 5. Datenimport (Erst-Befüllung aus Excel)

Kein Voll-Import wie heute (der erzeugte 189 „Projekte" mit Duplikaten, Müll und
754 „Frei"-Einträgen). Stattdessen ein **gestufter Import mit Validierung und
manueller Freigabe**. Quelle ist die Excel (`BILLY LIST …xlsx`, Blätter Jan–Dez).

### 5.1 Grundprinzip
Jede Stufe erzeugt zuerst einen **Validierungs-Report** (Liste mit Auffälligkeiten
+ Vorschlägen). Erst nach **manueller Freigabe/Korrektur** wird tatsächlich in
Postgres geschrieben. Reihenfolge: **Mitarbeiter → Projekte → Buchungen**
(Buchungen referenzieren die zuvor bereinigten Stammdaten).

### 5.2 Stufe 1 – Mitarbeiter
- Extrahieren, normalisieren (Trim, Mehrfach-Leerzeichen), E-Mail ergänzen.
- Report markiert: unvollständige Namen (z. B. „Cedric" ohne Nachname),
  Dubletten, fehlende E-Mail (Pflicht für späteres Personio-/SSO-Mapping).
- **Freigabe** → Insert in `employees`.

### 5.3 Stufe 2 – Projekte (mit Dedup)
- Report listet **mögliche Duplikate** in zwei Stufen:
  - **exakt nach Normalisierung** (Klein-/Sonderzeichen/Leerzeichen),
    z. B. `LivaNova/ Rauch` ↔ `LivaNova / Rauch`, `TU Update` ↔ `Tu-Update`.
  - **Fuzzy/Ähnlichkeit** (Tippfehler), z. B. `Wazir Holiding` ↔ `Wazir Holding`,
    `LaFutura` ↔ `La Futura`.
- Für jede Gruppe ein **Merge-Vorschlag** (Kanonischer Name + zusammenzuführende
  Varianten). Buchungen der Varianten werden beim Import auf das Ziel-Projekt umgehängt.
- Report markiert **Müll/Nicht-Projekte** zum Aussortieren, z. B. Projekt „0,5"
  (verrutschter Budgetwert), „Ausgleich freier Tag …".
- **Freigabe/Korrektur** → Insert in `projects` (nur echte Projekte).

### 5.4 Sonderfälle – freie Tage & Feiertage (kein Projekt)
- **Freie Tage** (Excel-Eintrag „Frei", „FREIER TAG", „Frei aus KW…", „Ausgleich",
  ~754 Einträge) → **nicht** als Projekt, sondern als Buchung auf die
  **System-Kategorie „Frei"** (`is_system`, nicht-buchbar, kein Projekt-Report).
  Reduziert die verfügbare Kapazität, bleibt im Plan sichtbar.
- **Urlaub / Krank / Admin** → bestehende System-Kategorien.
- **Feiertage** → **nicht importieren**. Werden über einen **deutschen
  Feiertagskalender automatisch** als nicht buchbar berechnet (v1.2).

### 5.5 Umsetzung
- Import-Logik als **Edge Function** (liest Excel/CSV, erzeugt Reports, schreibt
  nach Freigabe). Reports als herunterladbare Liste (CSV/Markdown).
- Wiederholbar & idempotent (versehentliche Doppelläufe erzeugen keine Dubletten).

---

## 6. Feature-Katalog (gruppiert)

**A. Projektmanagement** – Arbeitspakete (Soll/Ist), Meilensteine +
Rechnungs-Ampel, Projekt-Detailansicht (Gantt), Projekt-Templates.

**B. Integrationen** – Personio-Abwesenheiten (read-only), Zoho-Auftragsimport
(Closed Won → Projekt), Zoho-Pipeline-Forecast (offene Deals als weiche Last).

**C. Controlling** – Profitabilität pro Projekt/Kunde (Umsatz − Kosten),
Ist-Zeiterfassung, CSV-/Excel-Export, Team-Kapazitäts-Heatmap.

**D. Planungsqualität & Komfort** – deutsche Feiertage als nicht buchbar,
Überbuchungs-Warnung beim Buchen, Skill-/Rollen-Matrix, Read-only-Management-Link,
wöchentlicher Digest.

---

## 7. Versionsplanung / Roadmap

Das **Fundament steht bewusst zuerst** (solide/sichere Basis von Anfang an); das
Rechnungs-/Meilenstein-Dashboard ist das erste Feature direkt darauf.

### v1.1 – Fundament: Neuaufbau auf Supabase ⭐
**Ziel:** solide, sichere, relationale Basis + saubere Erstdaten.
- Postgres-Schema (Abschnitt 3) + RLS-Policies (4.6)
- Supabase Auth mit SSO (@trendone) – ersetzt das Client-Passwort
- Realtime-Anbindung (ersetzt `onSnapshot`)
- Frontend auf `@supabase/supabase-js` neu aufbauen (Firebase-SDK raus)
- **Gestufte Erst-Befüllung aus Excel** mit Validierung/Dedup (Abschnitt 5) –
  **keine** Migration der alten Firestore-Daten
- Edge-Functions-Gerüst + Vault + `pg_cron` aktivieren
- Voraussetzungen: keine · Risiko: mittel (Import-Qualität, RLS sorgfältig testen)

### v1.2 – Rechnungs- & Meilenstein-Dashboard ⭐ (erstes Feature)
**Ziel:** sofortiger Mehrwert „wann muss welche Rechnung raus".
- `milestones` nutzen; Projekt-Felder `client/status/budget_eur/end_date` pflegbar
- Dashboard mit Fälligkeits-Ampel (diese Woche / überfällig / nächste 30 Tage)
- CSV-Export der Auswertung
- **Quick Win:** deutsche Feiertage als nicht buchbar (automatischer Kalender)
- Voraussetzungen: v1.1 · Risiko: gering

### v2.0 – Erinnerungen (Mail/Teams)
- `send-digest` nutzt Meilensteine (v1.2) + Auslastung
- Voraussetzungen: v1.1 + v1.2 · Risiko: gering

### v2.1 – Zoho-Auftragsimport
- `sync-zoho` (Pull) + `zoho-webhook` (Closed Won), Mapping (4.4), Idempotenz
- Voraussetzungen: v1.1 · Risiko: mittel (OAuth/Token-Handling)

### v2.2 – Pipeline-Forecast
- offene Deals als weiche/gewichtete Last, Was-wäre-wenn-Ansicht, Kapazitäts-Check
- Voraussetzungen: v2.1 · Risiko: mittel

### v3.0 – PM-Kern: Arbeitspakete
- `workpackages`, Buchungen hängen an Paketen, Soll/Ist pro Paket
- Projekt-Detail-/Gantt-Ansicht
- Voraussetzungen: v1.1 · Risiko: mittel-hoch (UI-Umbau)

### v3.1 – Controlling
- Profitabilität pro Projekt/Kunde (Zoho-Umsatz − Kosten), Ist-Zeiterfassung
- Voraussetzungen: v2.1, v3.0 · Risiko: mittel

### v4.0 – Personio-Spiegelung (bewusst nach hinten priorisiert)
- read-only, technisch unabhängig; Urlaub/Krank bis dahin manuell wie heute
- `sync-personio`, E-Mail-Mapping + Mapping-Admin-View, gesperrte Buchungen
- Voraussetzungen: v1.1 · Risiko: mittel (Mapping, DSGVO mit HR)

### v5 – Komfort & Reichweite (laufend)
- Skill-Matrix, Projekt-Templates, Kapazitäts-Heatmap
- Read-only-Management-Link, Rollenmodell ausbauen

### Abhängigkeitsdiagramm
```
v1.1 (Fundament/Supabase) ─┬─▶ v1.2 (Dashboard) ─▶ v2.0 (Erinnerungen)
                           ├─▶ v2.1 (Zoho) ─▶ v2.2 (Pipeline-Forecast)
                           ├─▶ v3.0 (Arbeitspakete) ─▶ v3.1 (Controlling)
                           │                              ▲
                           │        v2.1 (Zoho) ──────────┘
                           └─▶ v4.0 (Personio)   ← unabhängig, bewusst nach hinten
```

---

## 8. Offene Punkte / vor Umsetzung klären
- **Supabase**: Projekt anlegen, Region (EU – Frankfurt), Pro-Tarif?
- **SSO**: Microsoft 365 als Identity-Provider für @trendone.com?
- **Excel-Quelle**: aktuelle `BILLY LIST …xlsx` bereitstellen; welche Blätter/Spalten
  gelten als maßgeblich (nur 2026 oder Historie)?
- **E-Mail-Adressen** der Mitarbeiter für Stufe 1 (Pflicht fürs spätere Mapping).
- **Hosting Frontend**: bei GitHub Pages bleiben oder auf Vercel wechseln?
- **Zoho**: Data-Center (.eu?), Self-Client, welche Stages = „Auftrag", Custom-Felder.
- **Personio**: API-Credentials, welche Abwesenheitstypen, DSGVO mit HR.
- **Tagessätze** für Profitabilität: pro MA, pro Rolle oder pauschal?

---

## 9. Grundsätze
1. Quellsysteme bleiben führend; die App spiegelt read-only.
2. Eine gemeinsame Backend-Schicht (Supabase Edge Functions) trägt alle Integrationen.
3. Sicher von Anfang an: echte Auth + Row-Level-Security ab v1.
4. Saubere Daten von Anfang an: validierter, gestufter Erst-Import statt Voll-Dump.
5. Schlank bleiben: kein Feature ohne klaren Mehrwert gegenüber der Excel-Liste.

---

## 10. Anhang: Begründung der Stack-Wahl (Supabase)

Geprüfte Optionen und Entscheidung:

| Kriterium | Firebase (Status quo) | **Supabase (gewählt)** | Railway (eigenes Backend) |
|---|---|---|---|
| Datenmodell | Dokument (schwach bei Joins/Reporting) | **Postgres, relational** | Postgres, relational |
| Sicherheit | Security-Rules-DSL | **Row-Level-Security in SQL** | selbst gebaut |
| Echtzeit | gratis | **eingebaut** | selbst bauen |
| Auth/SSO | gut | **gut (inkl. SSO)** | selbst bauen |
| Integrations-Bridge | Cloud Functions | **Edge Functions + pg_cron** | dauerhafter Server (sehr sauber) |
| Eigener Aufwand | gering | **gering** | höher |

**Warum Supabase:** bewahrt die Stärken von heute (Echtzeit-UX, Auth, wenig
Backend-Code) und liefert zugleich das relationale Fundament + ein ernsthaftes,
in der DB verankertes Sicherheitsmodell (RLS) – passend zur reporting-lastigen
Roadmap. **Railway** bleibt die Alternative, falls später ein voll eigenes
Backend gewünscht ist (Railway + Supabase lassen sich auch kombinieren).
