# Zoho-CRM-Anbindung – Anforderungen & Einrichtung

> Stand: 2026-06-27 · Companion zu [`konzept.md`](konzept.md) (Abschnitt 4.4, Roadmap v2.1)
> Zweck: vollständige Anforderungs- und Einrichtungsliste, um Zoho CRM read-only
> in unsere Postgres-`projects`-Tabelle zu spiegeln.

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

| # | Voraussetzung | Warum |
|---|---|---|
| 1 | **Zoho-CRM-Edition mit API-Zugriff** (Standard/Professional/Enterprise – nicht Free) | REST-API & Webhooks erst ab kostenpflichtigen Editionen sinnvoll nutzbar |
| 2 | **Admin-Rechte** (oder ein Admin, der Connected App + Workflow anlegt) | Connected Apps und Workflow-Regeln dürfen nur Admins erstellen |
| 3 | **Data-Center-Domain** identifizieren (.eu / .com / …) | bestimmt alle API-URLs; bei uns sehr wahrscheinlich **.eu** (Frankfurt) – muss verifiziert werden |
| 4 | Ein **Service-/Technik-Account** für die Integration (statt persönlichem Login) | Token hängt am User; persönlicher Account = Abriss beim Mitarbeiterwechsel |

**Data-Center prüfen:** In Zoho oben rechts auf das Profil → die URL in der Adresszeile
zeigt die Domain (`crm.zoho.eu` = EU, `crm.zoho.com` = US). Das entscheidet, ob wir
`accounts.zoho.eu`/`zohoapis.eu` oder `.com` verwenden.

---

## 3. Schritt für Schritt: OAuth-Zugang einrichten (Self-Client)

Für Server-zu-Server ohne Login-Umleitung nutzt Zoho den **Self-Client**.

### 3.1 Connected App anlegen
1. **Zoho API Console** öffnen: `https://api-console.zoho.eu` (EU) bzw. `.com` – passend zum Data Center.
2. **Add Client** → **Self Client** auswählen → bestätigen.
3. Zoho erzeugt **Client ID** und **Client Secret**. Beide notieren (kommen in den Vault).

### 3.2 Scopes festlegen (so eng wie möglich, read-only)
- `ZohoCRM.modules.deals.READ` – Deals lesen
- `ZohoCRM.settings.fields.READ` – Feld-API-Namen auslesen (für Mapping)
- `ZohoCRM.settings.modules.READ` – Modul-/Stage-Metadaten
- (optional, falls Kunde aus Account-Modul) `ZohoCRM.modules.accounts.READ`

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

## 4. Felder & Werte in Zoho identifizieren (Mapping)

Gebraucht werden die **API-Namen** der Felder, nicht die deutschen Anzeigenamen. Diese
stehen unter **Setup → Entwicklerbereich / Module und Felder → Deals → Feld → API-Name**.

| Konzept-Spalte | Zoho-Standardfeld (API-Name) | Zu klären |
|---|---|---|
| `name` | `Deal_Name` | – |
| `client` | `Account_Name` | – |
| `budget_eur` | `Amount` | – |
| `end_date` | `Closing_Date` | – |
| `status` | `Stage` | **welche Stage-Werte = „Auftrag/Closed Won"?** |
| `probability` | `Probability` | – |
| `external_id` | `id` (Deal-ID) | – |
| **`offer_number`** | **❓ Custom-Feld** | **welches Deal-Feld trägt die Angebotsnummer?** |

**Die zwei kritischen Klärungspunkte (Abschnitt 8 des Konzepts):**
1. **Angebotsnummer** – Join-Key zu Mite (Konzept 4.5). In **welchem Deal-Feld** steht die
   in Zoho generierte Angebotsnummer (Anzeigename + API-Name)? Ohne dieses Feld funktioniert
   die spätere Mite-Anbindung (v2.3) nur unscharf.
2. **Stage-Werte** – Welche Werte gelten als „Auftrag" (= Projekt anlegen), welche als „offen"
   (= Pipeline-Forecast, v2.2)? Exakte Liste der Stage-Namen.

---

## 5. Webhook für „Closed Won" einrichten (Push-Modus)

Damit ein gewonnener Deal **sofort** ein Projekt anlegt (statt erst beim nächsten cron-Lauf).

**Variante A – Workflow + Webhook (Standard):**
1. **Setup → Automatisierung → Workflow-Regeln → Regel erstellen**, Modul **Deals**.
2. Auslöser: **bei Bearbeitung eines Datensatzes**, Bedingung **`Stage` = „Closed Won"** (bzw. unser Auftrags-Wert).
3. Aktion: **Webhook** → Ziel-URL = Edge-Function-URL (`https://<projekt>.supabase.co/functions/v1/zoho-webhook`), Methode **POST**, relevante Deal-Felder als Parameter mappen.
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

1. ☐ **Data Center** bestätigen (.eu vermutlich) – per Blick in die Zoho-URL.
2. ☐ **Edition** nennen (Standard/Professional/Enterprise) – wegen API-Limits.
3. ☐ **Admin-Zugang** (oder Termin mit Zoho-Admin), um die Self-Client-App anzulegen.
4. ☐ **Angebotsnummer-Feld**: Anzeige- **und** API-Name im Deal-Modul.
5. ☐ **Stage-Liste**: welche Werte = „Auftrag", welche = „offene Pipeline".
6. ☐ Etwaige weitere **Custom-Felder** fürs Projekt (z. B. Projektnummer, Verantwortlicher).
7. ☐ Entscheidung: **nur Pull (`sync-zoho`)** zum Start oder gleich **mit Webhook**.
8. ☐ **Service-/Technik-Account** in Zoho, an den das Token gehängt wird?

Sobald 1–6 stehen, lässt sich in einer ~30-Min-Session gemeinsam Client + Refresh-Token
erzeugen (Punkt 3.3/3.4 sind zeitkritisch und am besten live).
