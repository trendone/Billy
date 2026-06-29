# Zoho-CRM-Anbindung – Anforderungen & Einrichtung

> Stand: 2026-06-29 · Companion zu [`konzept.md`](konzept.md) (Abschnitt 4.4, Roadmap v2.1)
> Zweck: vollständige Anforderungs- und Einrichtungsliste, um Zoho CRM read-only
> in unsere Postgres-`projects`-Tabelle zu spiegeln.

> **✅ LIVE seit 2026-06-29.** `sync-zoho` (COQL-Pull) ist deployt und per `pg_cron`
> alle 30 Min aktiv. Erstlauf: **174 Consulting-Projekte** in `projects` (Summe netto
> ~3,68 Mio. €), idempotent verifiziert. Implementierung im `superbilly`-Repo
> (`supabase/functions/sync-zoho/`). Token hängt am **Service-Account** (nicht an einer
> Person). Offen/optional: nur noch der Webhook (Abschnitt 5).

---

## 1. Was die Anbindung technisch tut

Laut Konzept spiegeln wir **read-only** aus Zoho CRM in `projects`. Zwei Betriebsarten:

| Modus | Zweck | Auslöser |
|---|---|---|
| **`sync-zoho`** (Pull, cron) | regelmäßiger Abgleich aller relevanten Deals | Zeitplan (`pg_cron`) |
| **`zoho-webhook`** (Push, http) | „Closed Won" → sofort Projekt anlegen | Zoho-Workflow bei Stage-Wechsel |

Die Edge Function authentifiziert sich per **OAuth 2.0** und schreibt mit Service-Role
in Postgres. Secrets liegen ausschließlich im **Supabase Vault**, nie im Frontend.

---

## 2. Voraussetzungen in Zoho (vorab prüfen)

| # | Voraussetzung | Status |
|---|---|---|
| 1 | **Edition mit API-Zugriff** | ✅ **Zoho One** (voller API-/Webhook-Zugriff) |
| 2 | **Admin-Rechte** für Connected App + Workflow | ✅ vorhanden (Peter hat Admin-Rolle) |
| 3 | **Data-Center-Domain** | ✅ **EU** → `accounts.zoho.eu` / `www.zohoapis.eu` |
| 4 | **Service-/Technik-Account** für die Integration (statt persönlichem Login) | ☐ offen – empfohlen, damit das Token nicht an einer Person hängt |

> Domains stehen fest (EU): Token-Endpoint `https://accounts.zoho.eu/oauth/v2/token`,
> API-Domain `https://www.zohoapis.eu`, API Console `https://api-console.zoho.eu`.

---

## 3. Schritt für Schritt: OAuth-Zugang einrichten (Self-Client)

Für Server-zu-Server ohne Login-Umleitung nutzt Zoho den **Self-Client**.

### 3.1 Connected App anlegen
1. **Zoho API Console** öffnen: `https://api-console.zoho.eu` (EU) bzw. `.com` – passend zum Data Center.
2. **Add Client** → **Self Client** auswählen → bestätigen.
3. Zoho erzeugt **Client ID** und **Client Secret**. Beide notieren (kommen in den Vault).

### 3.2 Scopes festlegen (so eng wie möglich, read-only)
- `ZohoCRM.modules.deals.READ` – Verkaufschancen (Deals) lesen
- `ZohoCRM.modules.quotes.READ` – Angebote (Quotes) lesen – liefert Angebotsnummer & Betrag
- `ZohoCRM.coql.READ` – **COQL-Abfragen** (modulübergreifender Join, s. 4.3) – **erforderlich**
- `ZohoCRM.settings.fields.READ` – Feld-API-Namen auslesen (für Mapping)
- `ZohoCRM.settings.modules.READ` – Modul-/Stage-Metadaten

Vollständiger Scope-String (verwendet):
```
ZohoCRM.modules.deals.READ,ZohoCRM.modules.quotes.READ,ZohoCRM.coql.READ,ZohoCRM.settings.fields.READ,ZohoCRM.settings.modules.READ
```

### 3.3 Grant-Token erzeugen (Self-Client-Tab)
1. Im Self-Client → Tab **Generate Code**.
2. Scopes aus 3.2 (kommagetrennt) eintragen.
3. Gültigkeitsdauer wählen (3–10 Min reichen) + Beschreibung.
4. Portal/Production auswählen → **Create** → **grant code** (kurzlebig!).

### 3.4 Grant-Token → Refresh-Token tauschen (einmalig, serverseitig)
```
POST https://accounts.zoho.eu/oauth/v2/token
  grant_type=authorization_code
  client_id=...
  client_secret=...
  code=<grant code aus 3.3>
```
→ Antwort enthält **`refresh_token`** (langlebig) + `access_token` (1 h). Nur das
**Refresh-Token** wird dauerhaft im Vault gespeichert; das Access-Token erneuert die
Function bei jedem Lauf selbst.

> **Wichtig:** Der grant code ist nur wenige Minuten gültig und nur **einmal** einlösbar.
> Den Tausch direkt nach dem Erzeugen machen – am besten gemeinsam in einer kurzen Session.

---

## 4. Datenstruktur & Mapping (zwei verknüpfte Module)

Bei uns hängt an einer **Verkaufschance (Deals)** ein **Angebot (Quotes)**. Die für die
Spiegelung relevanten Felder verteilen sich auf **beide** Module – ein Projekt entsteht
aus der **Kombination** von Deal + verknüpftem Quote.

- **Deals (Verkaufschance):** Projektname, Kunde, Leistungsdatum, **Filter „Consulting"**,
  Verknüpfung zum Angebot.
- **Quotes (Angebote):** **Angebotsnummer** (= Join-Key zu Mite) und **Betrag**.

Verknüpft sind sie über das Lookup-Feld **`Angebot`** am Deal (zeigt auf einen Quote-Datensatz).

### 4.1 Filter – nur relevante Projekte
Nur **Consulting**-Projekte sind für uns interessant:
`Deals.Leistungsbereich = "Consulting"`. Der Sync zieht ausschließlich diese Deals.

### 4.2 Feld-Mapping → `projects`
API-Namen stehen unter **Setup → Entwicklerbereich / Module und Felder → Feld → API-Name**.

_API-Namen am 2026-06-27 live gegen das Zoho-EU-Portal verifiziert._

| `projects`-Spalte | Modul | Zoho-Feld (API-Name) | Anmerkung |
|---|---|---|---|
| `name` | Deals | `Deal_Name` | – |
| `client` | Deals | `Account_Name` | Lookup (liefert Firmenname) |
| `end_date` | Deals | `Leitungserbringung` | Leistungsdatum (API-Name **ohne** „s", verbatim – Tippfehler im API-Namen) |
| _(Filter)_ | Deals | `Leistungsbereich` | Picklist, muss `= "Consulting"` |
| _(Verknüpfung)_ | Quotes | `Deal_Name` | Lookup Quote → Deal (zuverlässig gepflegt; s. 4.3) |
| `external_id` | Deals | `id` (Deal-ID) | Idempotenz |
| `status` | Quotes | `Quote_Stage` | `∈ {"Beauftragt", "Teilweise beauftragt"}` → Auftrag |
| **`offer_number`** | **Quotes** | **`Angebotsnummer`** | **autonumber, Join-Key zu Mite (Konzept 4.5)** |
| `budget_eur` | Quotes | `Sub_Total` | Betrag **netto** (Formel; nicht `Grand_Total`/brutto) |
| _(Angebotsname)_ | Quotes | `Subject` | optional, Anzeige |
| _(Altnummer)_ | Quotes | `Angebot_Nummer_Altsystem` | Text; Fallback fürs Mite-Matching alter Angebote |

### 4.3 Sync-Ablauf (angebotsgetrieben, eine COQL-Abfrage)
**Hintergrund (an Live-Daten verifiziert):**
- Das Lookup `Deals.Angebot` ist in der Praxis **fast immer leer** – auch bei gewonnenen
  Deals. Verlässlich gepflegt ist die **Gegenrichtung** `Quotes.Deal_Name`. → angebotsgetrieben.
- Die **Such-API ist bei 2000 Treffern hart gedeckelt**; es gibt **>2000** beauftragte
  Angebote insgesamt, und die Suche kann nicht modulübergreifend nach `Leistungsbereich`
  (am Deal) filtern. → **COQL** statt Such-API.

COQL filtert serverseitig über die Modulgrenze und liefert alles in **einer** Abfrage:
```sql
select Angebotsnummer, Sub_Total, Quote_Stage, Deal_Name,
       Deal_Name.Account_Name, Deal_Name.Leitungserbringung
from Quotes
where Quote_Stage in ('Beauftragt','Teilweise beauftragt')
  and Deal_Name.Leistungsbereich = 'Consulting'
```
→ `external_id ← Deal_Name.id`, `name ← Deal_Name.name`, `client ← Deal_Name.Account_Name`,
`end_date ← Deal_Name.Leitungserbringung`, `budget_eur ← Sub_Total`,
`offer_number ← Angebotsnummer`, `status ← 'aktiv'`, `source ← 'zoho'`.
Upsert idempotent über `external_id` (Deal-`id`).

**Live-Ergebnis (2026-06-29):** 175 beauftragte Consulting-Angebote, **alle mit
Angebotsnummer** (0 ohne), Summe netto ~3,69 Mio. €. Eine Abfrage, weit unter dem Limit.

> Implementierung: `superbilly/supabase/functions/sync-zoho/` (+ Migration
> `…120000_add_offer_number.sql`, Cron-Anleitung in der dortigen README).

### 4.4 Geklärte Festlegungen
1. **Auftrags-Logik:** maßgeblich ist `Quotes.Quote_Stage ∈ {"Beauftragt", "Teilweise beauftragt"}`
   → Projekt anlegen. (Achtung: den Wert „Gewonnen" gibt es **nicht** als Quote-Stage; das
   steckt in der Deal-Stufe `Abgeschlossen (gewonnen)`, ist hier aber nicht maßgeblich.)
2. **Betrag:** **netto** → `Quotes.Sub_Total` (Formelfeld; nicht `Grand_Total`/brutto).
3. **Kardinalität:** ein Deal hat **genau ein** Angebot → das über `Angebot` verknüpfte Quote
   ist eindeutig maßgeblich, kein Mehrdeutigkeits-Handling nötig.
4. **Projekt-Datum:** `projects.end_date` aus `Deals.Leitungserbringung` (einzelnes Leistungsdatum).
   Das Quotes-Modul böte zwar `Leistungsbeginn`/`Leistungsende` (Zeitraum), wird hier aber bewusst
   nicht genutzt.
5. **Angebotsnummer:** Join-Key ist `Quotes.Angebotsnummer` (autonumber); für Altangebote
   zusätzlich `Angebot_Nummer_Altsystem` als Fallback fürs Mite-Matching.

Feld-API-Namen und Picklist-Werte sind **live gegen das Portal verifiziert** – keine offenen
Mapping-Fragen mehr.

---

## 5. Webhook für „Closed Won" einrichten (Push-Modus)

Damit ein gewonnener Deal **sofort** ein Projekt anlegt (statt erst beim nächsten cron-Lauf).

**Variante A – Workflow + Webhook (Standard):**
1. **Setup → Automatisierung → Workflow-Regeln → Regel erstellen** – Modul **Quotes**.
2. Auslöser: **bei Bearbeitung eines Datensatzes**, Bedingung **`Quote_Stage` ist „Beauftragt" oder „Teilweise beauftragt"**
   (zusätzlich am verknüpften Deal `Leistungsbereich = "Consulting"`, falls im Workflow prüfbar – sonst in der Function).
3. Aktion: **Webhook** → Ziel-URL = Edge-Function-URL (`https://<projekt>.supabase.co/functions/v1/zoho-webhook`), Methode **POST**, relevante Felder beider Module als Parameter mappen.
4. **Sicherheit:** einen **gemeinsamen Geheim-Token** als zusätzlichen Parameter/Header mitschicken
   (Zoho-Webhooks sind nicht signiert) – die Function prüft ihn.

**Variante B – Workflow + Funktion (Deluge), falls reichere Payload nötig:** statt
Webhook-Aktion eine **Custom Function**, die einen sauberen JSON-POST baut. Erst, wenn
die einfache Webhook-Variante zu eng wird.

> Der Webhook ist **Komfort/Sofortigkeit**. Der `sync-zoho`-Pull (cron) ist die robuste Basis
> und fängt alles ab, was der Webhook verpasst (Idempotenz über die Deal-ID). Wir können mit
> reinem Pull starten und den Webhook später nachrüsten.

---

## 6. Was am Ende in den Vault kommt

| Secret | Quelle |
|---|---|
| `ZOHO_CLIENT_ID` | aus 3.1 |
| `ZOHO_CLIENT_SECRET` | aus 3.1 |
| `ZOHO_REFRESH_TOKEN` | aus 3.4 |
| `ZOHO_ACCOUNTS_DOMAIN` | z. B. `accounts.zoho.eu` |
| `ZOHO_API_DOMAIN` | z. B. `www.zohoapis.eu` |
| `ZOHO_WEBHOOK_SECRET` | generiert, in Zoho eingetragen |

---

## 7. Checkliste – was geliefert werden muss

**Bereits geklärt:** Data Center **EU**, Edition **Zoho One**, **Admin-Rolle** vorhanden;
Modulaufbau (Deals + Quotes), Filter (`Leistungsbereich = Consulting`), Auftrags-Logik
(`Quote_Stage ∈ {Beauftragt, Teilweise beauftragt}`), Betrag **netto** (`Sub_Total`),
Deal↔Quote = 1:1, Feld-Mapping inkl. Angebotsnummer (`Quotes.Angebotsnummer`) – **alle
API-Namen live verifiziert** (Abschnitt 4). **OAuth-Zugang ist eingerichtet** (Self-Client +
Refresh-Token erzeugt, 2026-06-27).

**Erledigt:** Refresh-Token + Client-Credentials als **Edge Function Secrets** im
Remote-Projekt `rzsptpfgzfigxmyyqdas` hinterlegt (`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
`ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNTS_DOMAIN`, `ZOHO_API_DOMAIN`).

**Noch offen:**
1. ☐ Etwaige weitere **Custom-Felder** fürs Projekt (z. B. Projektnummer, Verantwortlicher).
2. ☐ Entscheidung: **nur Pull (`sync-zoho`)** zum Start oder gleich **mit Webhook**.
3. ☐ **Service-/Technik-Account** in Zoho, an den das Token gehängt wird (empfohlen –
   aktuell hängt das Token am Admin-Account).

Damit ist die Zoho-Seite startklar für den Bau der `sync-zoho` Edge Function (Roadmap v2.1).
