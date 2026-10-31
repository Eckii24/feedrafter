# Agentic News Reader – technische Skizze

**Status:** Entwurf zur Diskussion, keine Implementierungsfreigabe. Grundlage sind die bestätigten [Architekturentscheidungen](architecture.md) und die [Produktspezifikation](dev-agentic-news-reader-spec.md). Importentkopplung (F1), direkter TypeSafe-JEV-Zugang (F2) und automatische Kontextaufbereitung (F4) sind bestätigt. Weitere Mechanismen und Zahlen unten bleiben Vorschläge, keine bereits bestätigten Defaults. Das Vier-Stunden-Ziel ab Import (F3) ist bestätigt; offen sind die tatsächliche Video-/Audiolast und der Kapazitätsnachweis.

## 1 · Aufbau und Abhängigkeitsrichtung

- Fachmodule: Import, Inhalte, Kategorien/Schlagwörter, Scores/Feedback, Reader, Integrationen und Chat.
- Geschäftsregeln und Anwendungsfälle als normale TypeScript-Module. Ports nur an tatsächlichen Grenzen: Persistenz, Pi, FreshRSS, Karakeep, Medienwerkzeuge und Uhrzeit. Kein generisches Repository-Framework oder DI-Framework erforderlich.
- HTTP-Handler und Job-Handler rufen dieselben Anwendungsfälle auf. Drizzle-/Fastify-/Pi-Typen nicht in die Geschäftsregeln durchreichen.
- Ein Composition Root verbindet Adapter, API und Runner. CLI-Einstieg für Migrationen und OAuth-Einrichtung im selben Image, aber ohne Start der Web-App.
- React/Vite bleibt ein separater Build innerhalb desselben Repositorys. Nur explizite API-Verträge teilen, keine Servermodule oder Credentials ins Browser-Bundle importieren.

## 2 · Relationales Datenmodell

Interne IDs als UUIDs, beispielsweise mit Nodes `crypto.randomUUID()` erzeugt; FreshRSS-IDs unverändert als Text. Zeitpunkte als `timestamptz`. Fachliche Zustände durch Checks und Fremdschlüssel absichern. Namen unten sind Arbeitsnamen, noch kein fertiges SQL-Schema.

| Tabellen/Aggregate | Wesentliche Daten und Regeln |
| --- | --- |
| `import_contexts` | FreshRSS-Instanz-/Kontokontext; zunächst eine konfigurierte Quelle, keine zusätzliche Multiuser-Funktion. Keine Credentials. |
| `sources` | Feed-ID innerhalb dieses Kontexts, Name, URL, manueller Präferenzoffset. Eindeutig je Kontext/externer Feed-ID. |
| `articles` | Kontext, FreshRSS-ID, Quelle, Titel/URL/Autor/Publikationszeit soweit vorhanden, Importzeit, Artikel/Video, eigener Lesestatus, Mailstatus, Hauptkategorie. `UNIQUE(context_id, freshrss_id)`; keine URL-Unique-Regel. |
| `article_contents` | Ein aktueller Inhalt je Artikel: vollständiger verfügbarer Text/Markdown oder Transkript, Inhaltsrevision, Qualitäts-/Vollständigkeitsstatus, Fehlerhinweis. Fehlender Inhalt bleibt fehlend. |
| `content_chunks`, `chunk_results` | Bei nötiger Segmentierung: nachvollziehbare Text-/Zeitbereiche und schrittweise Ergebnisse je Inhaltsrevision und Verarbeitungsgeneration. Kein Vektorindex und keine Prompt-/Modellkonfigurationshistorie. |
| `categories` | Konfigurierbare Kategorien und genau ein geschützter Fallback „Nicht zugeordnet“. Jeder Artikel verweist auf genau eine Kategorie. |
| `tags`, `article_tags` | Katalog mit normalisiertem eindeutigen Namen und manuellem Offset; eindeutige Artikel–Tag-Zuordnung. Normalisierung nur für technische Schreibvarianten, keine automatische semantische Zusammenführung. |
| `tag_votes`, `source_votes` | Getrennte Tabellen mit echten Fremdschlüsseln; je Artikel/Ziel ein Wert aus `-1, 0, +1` und Zeitpunkt der letzten Voting-Aktion. Votes auf entfernte Tag-Zuordnungen bleiben erhalten. |
| `score_definitions`, `score_category_prompts` | Name, Beschreibung, Prompt, aktiv/deaktiviert/soft gelöscht, erlaubte Kontextfelder; optionale Kategorie-Overrides. Keine Hard Deletes von Scores. |
| `article_scores` | Letzter erfolgreicher Wert je Artikel/Score, Berechnungszeit und eingeschränkte Grundlage, falls zutreffend. Endlicher numerischer Wert 0–100; fehlender Wert ist nicht null Punkte. Keine verantwortliche Prompt-/Modellkonfigurationsversion speichern. |
| `article_summaries` | Letzte erfolgreiche Zusammenfassung je Artikel. Erst bei erfolgreicher Neuerstellung ersetzen. |
| `freshrss_acknowledgements` | Dauerhaft ausstehende/bestätigte Übernahmebestätigung je importiertem Eintrag; Fehler und nächster Versuch. Unabhängig vom Auftauchen in späteren Ungelesen-Abfragen. |
| `processing_runs`, `processing_tasks` | Lauf und Schritte mit Artikelbezug, Status, Generation/Ausführungstoken, Fehlercode und nächstem Versuch. Fachlicher Fortschritt, keine selbst gebaute zweite Jobqueue. |
| `app_settings`, `usage_ledger` | Validierte Settings für Rollen/Modelle, Limits, Zeitplan und Präferenzverfall; Nutzungsreservierungen und Verbrauch für Budgetprüfung. Keine Prompt-Historie oder Secret-Ablage. |
| `chat_session_refs` | Interne Session-ID und kontrollierte Referenz auf Pis Session-Datei. Pi bleibt Quelle für den Gesprächsinhalt; kein zweites Chattranskript in PostgreSQL. |

**Zentrale Schreibregeln:**

- Import legt neue Artikel an; Konflikte dürfen Lesestatus, Feedback, Mailstatus, manuelle Zuordnungen oder vorhandene Ergebnisse nicht zurücksetzen.
- Jede Voting-Aktion setzt den Vote-Zeitpunkt neu, auch bei gleichem Wert. Neutralisieren speichert `0`; Entfernen löscht den Vote. Gewichte werden zu einem gemeinsamen Bewertungszeitpunkt aus Votes berechnet, nicht als veraltende Wahrheit gespeichert.
- Tag-Merge als eine Transaktion: alle beteiligten Votes inklusive Ziel gemeinsam aggregieren, Vorzeichen der Summe und neuestes beteiligtes Vote-Datum verwenden, Offsets addieren, Zuordnungen umstellen, dann alte Tags löschen. Ohne vorhandenen Vote keinen neuen Vote erfinden.
- Asynchrone Ergebnisse nur übernehmen, wenn die relevante Artikel-/Katalogrevision noch passt. Manuelle Korrekturen und neuere Aufträge dürfen nicht von verspäteten Jobs überschrieben werden. Diese Revisionen sind keine Prompt-/Modellkonfigurationsversionen.
- Nicht-destruktiver Startvorschlag für Kategorien: archivieren statt hart löschen; bestehende Zuordnungen erhalten, archivierte Kategorien nicht neu automatisch vergeben. Technischen Fallback nicht archivieren.
- Bei erneuter Score-Berechnung alte erfolgreiche Einzelwerte bis zum jeweiligen neuen Erfolg behalten. Fehlversuch und Alter sichtbar anzeigen; ohne bisherigen Erfolg bleibt der Wert leer. Keine neue Score-Historie als Zusatzfunktion.

**Erste Indizes:** eindeutige Importidentität, eindeutige Artikel–Tag-/Vote-/Score-Paare, Artikel nach Lesestatus/Sortierdatum/ID, Scores nach Score-ID/Wert/Artikel-ID sowie Votes nach Ziel. Weitere Filterindizes erst anhand realer Abfragen und Datenmenge.

## 3 · Import, Verarbeitung und Wiederanlauf

### FreshRSS-Übernahme

1. Einen Importlauf atomar anlegen beziehungsweise den bestehenden aktiven Import zurückgeben. DB-seitige Invariante gegen parallele FreshRSS-Importe verwenden; pg-boss-Singleton allein ersetzt sie nicht. Ältere Artikeljobs blockieren diesen Start nicht.
2. Ungelesene Einträge seitenweise abrufen. Jede Seite dauerhaft speichern: Artikel, ausstehende Bestätigung und notwendige Verarbeitungsschritte. App-Schritt und pg-boss-Auftrag in derselben Drizzle-Transaktion erzeugen.
3. Während der gesamten paginierten Abfrage keine eigenen Read-Markierungen durchführen – auch nicht durch einen unabhängigen Bestätigungs-Retry. Fetch und Bestätigung über einen gemeinsamen FreshRSS-Koordinator serialisieren.
4. Erst nach vollständig durchlaufener Seitenfolge konkrete gespeicherte IDs bestätigen. Mehrdeutige Fehler durch Zustandsprüfung auflösen; ausstehende Bestätigungen dauerhaft weiterführen. Fehlgeschlagene Bestätigungen dürfen nicht zum Verlust der Artikel führen.
5. Nach Abbruch eine neue Abfrage vom Anfang starten und anhand der IDs deduplizieren; einen alten Pagination-Cursor nicht als konsistenten Snapshot behandeln.

Der vollständige Erstimport wird nicht künstlich auf eine Artikelzahl gekappt. Nutzungslimits pausieren Modell-/Transkriptionsarbeit, nicht das dauerhafte Speichern von Einträgen. Neue Importe dürfen beginnen, während ältere Artikeljobs warten oder laufen. Importstatus und artikelbezogenen Aufbereitungsstatus deshalb getrennt anzeigen.

### Artikelbezogene Schritte

`Inhalt/Transkript + Qualitätsstatus → Kategorie → Schlagwörter → aktive Scores`

Vor jedem Modellschritt bei Bedarf dessen gewählten Kontext segmentieren und verdichten; siehe Abschnitt 5. Kein unnötiges Chunking für einen Score, dessen ausgewählter Titel-/Metadatenkontext bereits passt.

- Artikel zunächst deterministisch extrahieren; Videos zunächst über Untertitel, sonst Audio/Transkription aufbereiten. Agentischer Fallback nur für freigegebene Quellen.
- Gültige leere Tag-Liste von fehlgeschlagenem Tagging unterscheiden. Abhängige Score-Aufrufe warten auf verfügbare Schlagwörter; andere Artikel laufen weiter.
- Manuelle Neubewertung berechnet alle aktiven Scores mit den aktuell vorhandenen Zuordnungen. Sie erzeugt keine automatische Neukategorisierung oder neue Schlagwörter.
- Zusammenfassung nur auf ausdrücklichen Auftrag; Karakeep ebenfalls nur als bewusste Aktion. Gleiche noch laufende Artikelaktion nicht durch Doppelklick mehrfach starten.
- Chat bleibt ein direkter SDK-Vorgang mit begrenzten Modell-/Tool-Aufrufen, nicht ein blind wiederholter pg-boss-Job. Je Session höchstens ein aktiver Turn; nach Absturz gespeicherte Session laden und unterbrochenen Turn sichtbar behandeln, nicht automatisch dieselbe Nutzernachricht erneut anhängen.

### Zustände und Fehler

Vorschlag für fachliche Schritte:

`queued → running → succeeded`

Zusätzlich `retry_wait`, `paused_budget`, `paused_auth`, `needs_input`, `failed` und `superseded`. `needs_input` gilt etwa für Kontext-/Dateigrenzen; `superseded` für veraltete Ergebnisse. Lesestatus und Mailstatus bleiben davon unabhängig.

- Bei vorübergehenden Netzwerk-/Serverfehlern maximal drei Versuche insgesamt; Startvorschlag 30 und 60 Sekunden Backoff mit Jitter, `Retry-After` berücksichtigen. Jeder Versuch zählt gegen das Budget.
- Auth-/Berechtigungsfehler pausieren die betroffene Modellkonfiguration; kein identischer Fehler pro Artikel in einer Endlosschleife. Nicht unterstützte Fähigkeiten, Paywall und ungültige Eingaben nicht blind erneut aufrufen.
- Bei mehrdeutigem Karakeep-Ergebnis vor Wiederholung nach bestehendem Bookmark suchen, soweit die API das zuverlässig erlaubt. Externe KI-Aufrufe können nach Absturz trotzdem doppelt erfolgen.
- Ein Ausführungstoken schützt Ergebnis-Commits vor verspäteten alten Versuchen. Abgelaufene Worker können noch laufen; keine Exactly-once-Behauptung.
- Lange Transkription als kontrollierter Unterprozess. Prozess-Timeout kürzer als Job-Ablaufzeit konfigurieren; aus Audio-Abschnittslänge und gemessenem Durchsatz mit Sicherheitsreserve ableiten, nicht als fixe Gesamtlängengrenze für Videos. 30 Sekunden Heartbeat als Startvorschlag; den pg-boss-Standard von 15 Minuten nicht ungeprüft übernehmen.
- Umsetzungsvorschlag für sehr lange Audios: abschnittsweise transkribieren und fertige Abschnitte checkpointen. Abschnittsgrenzen/Überlappung und Zusammenführung im Qualitätsbenchmark prüfen. So bleiben einzelne Versuche begrenzt, ohne eine maximale Videolänge vorzuschreiben; maximal ein lokaler Transkriptionsprozess insgesamt.

## 4 · HTTP- und Ereignisvertrag

Basis `/api/v1`, JSON mit Laufzeitvalidierung, OpenAPI aus Schemas. Asynchrone Aktionen liefern `202` und eine Job-/Laufreferenz; bei bereits laufender identischer Aktion den bestehenden Auftrag zurückgeben. Fehlerformat etwa `{ error: { code, message, requestId } }`; keine Secrets oder ungefilterten Providerantworten.

| Route/Gruppe | Zweck |
| --- | --- |
| `GET /articles`, `GET /articles/:id` | Gefilterte globale Liste und Detail mit Inhalt, Ergebnissen und Schrittstatus. |
| `PATCH /articles/:id` | Nur erlaubte persönliche Felder, etwa Lesestatus/Hauptkategorie; kein beliebiges Überschreiben des Artikels. |
| `PUT/DELETE /articles/:id/tags/:tagId` | Tag zuordnen/entfernen, bestehende Votes erhalten. |
| `POST /articles/:id/feedback` | Mehrere Tag-/Quellenziele atomar bewerten; kein Artikel-Daumen. Löschen einzelner Votes über zielbezogenen DELETE-Endpunkt. |
| `POST /articles/:id/reevaluations`, `POST /articles/:id/summaries`, `POST /articles/:id/content-retries` | Aktive Scores neu berechnen, Zusammenfassung erzeugen oder fehlgeschlagene Aufbereitung wiederholen. |
| `POST /articles/:id/karakeep` | Bewusst Original-URL speichern; Ergebnis/Fehler über Auftrag abrufbar. |
| `PUT /articles/:id/mail-selection` | Nur vorgemerkt/nicht vorgesehen setzen; gesendete Artikel nicht stillschweigend zurücksetzen. |
| `GET /mail-queue`, `POST /mail-queue/acknowledgements` | Vorgemerkte Artikel mit stabilen IDs/Inhalten abrufen; explizite IDs als gesendet bestätigen. Wiederholung bereits gesendeter IDs ist idempotent. |
| `POST /pipeline/runs`, `GET /pipeline/runs/:id` | Manuell starten/existierenden Lauf liefern, Fortschritt abrufen. |
| `POST /processing-tasks/:id/retry` | Sichtbar fehlgeschlagenen/pausierten Schritt nach Behebung erneut starten; Limits weiter prüfen. |
| Kategorien-/Tag-/Score- und Settings-Routen | Kataloge, Overrides, Gewichte/Offsets, Modelle, Zeitplan und Limits verwalten; `POST /tags/merge` für atomaren Merge. Keine Secrets zurückliefern. |
| `GET/POST /chat/sessions`, Session-/Message-Routen | Pi-Sessions auflisten/starten/laden und Nachrichten senden. Externe Eingaben enthalten interne IDs, niemals beliebige Session-Dateipfade. |
| `GET /events` | SSE für Fortschritt, Chat-Deltas und Hinweise auf geänderte Daten. |

**Liste:** Standard ungelesen/Signal absteigend. Filter und Sortierung vollständig in SQL vor Pagination anwenden. Score-Werte mit `NULLS LAST`, danach stabiler Datums-/ID-Tiebreaker. Datumsvorschlag: Publikationszeit, ersatzweise Importzeit; fehlende Publikationszeit weiterhin als fehlend anzeigen. Cursor-Pagination, Startgröße 50, Maximum 100. Cursor an Filter/Sortierung binden. Änderungen während des Blätterns sind kein garantierter Snapshot; UI nach relevanten Änderungen neu laden.

**Mail-API:** pro übermittelter ID bestätigte/bereits bestätigte/abgelehnte IDs ausweisen. Unbekannte oder nicht vorgemerkte IDs nicht unbeabsichtigt als gesendet markieren. Kein Lease-/Versandsystem und keine Exactly-once-Zustellung ergänzen.

**SSE:** flüchtiger Transport, kein zweites dauerhaftes Eventlog. Nach Neuverbindung einen aktuellen Snapshot laden; Anzeige nicht auf vollständigen Empfang alter Deltas stützen. Heartbeats und angemessene Timeouts; Streaming ohne störendes Proxy-Buffering am vorhandenen Nginx Proxy Manager prüfen.

## 5 · Modelle, Budgets und Ressourcen

### Modellzuordnung

- Ein gemeinsamer Pi-Modell-/Auth-Runtime für direkte Classifier-/LLM-Aufrufe und SDK-Sessions.
- `typesafe/jev-latest` direkt bei TypeSafe mit `TYPESAFE_API_KEY` für Klassifikation; OpenAI Codex OAuth für generative Aufgaben. Konkrete Codex-Modell-ID aus der Einrichtung übernehmen statt raten.
- Pi 1.4.0 führt für `typesafe/jev-latest` eine Kontextgröße von 64.000 Tokens. Das ist Modellmetadatum, keine nachgewiesene service-/endpunktspezifische Request-Garantie.
- Kontext vor Aufruf inklusive Prompt, Metadaten und Fragen prüfen, Reserve einplanen. Bei nicht exakt messbarer Tokenzahl konservativ schätzen und Providerfehler sichtbar behandeln. Nicht auf automatische Begrenzung durch Pi vertrauen.

### Automatische Kontextaufbereitung

Segmentierung/Verdichtung ist bestätigt; folgender Ablauf ist der technische Umsetzungsvorschlag:

1. Kontext je Zielaufgabe und Score-Konfiguration zusammenstellen. Passt er direkt, ohne zusätzliche Verdichtung aufrufen; ausgeschaltete Kontextfelder nicht über Umwege wieder einschleusen.
2. Zu großen Inhalt an nachvollziehbaren Absatz-/Zeitgrenzen vollständig in begrenzte Chunks zerlegen, kleine nötige Überlappungen berücksichtigen. IDs und Bereiche an die Inhaltsrevision binden; Originaltext/Transkript vollständig erhalten.
3. Reguläres Pi-LLM erzeugt je Chunk aufgabenbezogene Belege/Teilergebnisse mit Chunk-Referenzen. Nicht nur eine generische Kurzfassung für beliebige Scores verwenden: etwa Hype-Indikatoren und überprüfbare Details dürfen bei der Verdichtung nicht gezielt verschwinden. Trotzdem keine verlustfreie Bedeutungsbewahrung behaupten.
4. Ergebnisse bei Bedarf hierarchisch weiter verdichten, bis der finale Kontext passt. Abdeckung und Referenzen bewahren, Überschneidungen nicht als zusätzliche unabhängige Evidenz zählen. Fehlende Fortschritte oder ungültige Ausgabe führen zu einem sichtbaren Fehler, nicht zu einer Endlosschleife oder blindem Abschneiden.
5. Finale Kategorie und Scores durch den vorgesehenen Classifier auf dieser Grundlage berechnen; globale Tags per regulärem LLM normalisieren und auf höchstens zehn begrenzen. Kein pauschaler Mittelwert von Chunk-Scores als allgemeiner Gesamtscore. Konfigurierte Score-Prompts, Kontextfelder und artikelrelevante Gewichte weiter beachten.
6. Scores mit verdichtetem Inhalt als solche kennzeichnen, bearbeitete/gesamte Chunks und Quellenqualität nachvollziehbar halten. Unvollständige Chunk-Verarbeitung nicht als fertiges vollständiges Ergebnis ausgeben; vorhandene erfolgreiche Werte bis zum neuen Erfolg behalten.
7. Fertige Chunk-Ergebnisse für Wiederanlauf speichern, aber nur innerhalb passender Inhaltsrevision/Verarbeitungsgeneration wiederverwenden. Explizite neue Bewertung darf nicht alte Zwischenresultate als neue Berechnung ausgeben. Keine Prompt-/Modellkonfigurationsversion pro Score hinzufügen.
8. Zusätzliche Modellrequests gegen das Budget der auslösenden Arbeit zählen: automatische Aufbereitung automatisch, angeforderte Zusammenfassung interaktiv. Bei Budgetpause übrige Chunks fortsetzbar halten und andere Artikel weiterverarbeiten. Chat-Inhalte über begrenzte lesende Artikel-/Chunk-Werkzeuge statt unbeschränkten Volltext-Import bereitstellen.

### Numerische Pilotvorschläge – noch nicht freigegeben

| Arbeitsart | Grenze je UTC-Kalendertag | Gleichzeitig |
| --- | --- | --- |
| Automatische generative Modellaufrufe | 50 Aufrufe | 1 |
| Interaktive Modellaufrufe, inklusive Zusammenfassungen/Chat | 50 Aufrufe | 1 |
| Classifier | 2.000 Aufrufe | 2 |
| Lokale Transkription | Keine pauschale Tagesquote; Audio-Minuten erfassen, optionales Limit | 1, zunächst 2 CPU-Threads |

Bewusst kleine Pilotwerte, keine Kostenprognose und keine Aussage über Produktionsdurchsatz. Ein Agentenstart ist nicht nur ein Aufruf: sämtliche tatsächlichen Modellrequests und Wiederholungen berücksichtigen. Classifier-Batching nicht ungeprüft als feste Aufrufzahl pro Artikel annehmen.

Nutzung vor Arbeit atomar in PostgreSQL reservieren, danach anhand verfügbarer Verbrauchsdaten abrechnen. Mehrdeutig fehlgeschlagene externe Requests nicht optimistisch als kostenlos behandeln. Fehlende Token-/Kostenwerte als unbekannt kennzeichnen; verlässliche Aufrufgrenzen bleiben wirksam. SDK-/Provider-interne Requests und Retries müssen in der technischen Integration berücksichtigt werden. Pause an Schrittgrenzen; ein bereits gesendeter Providerrequest lässt sich nicht verlässlich rückgängig machen.

**Ressourcen-Startvorschläge:**

- `whisper.cpp` mit multilingualem `small`, gegebenenfalls quantisiert, zunächst nur als Benchmark-Kandidat. Vier Kerne/8 GB sind der gesamte geteilte Host; keinen freien RAM daraus ableiten.
- Zwei gleichzeitige Artikelabrufe, höchstens eine DOM-Extraktion in einem Worker-Thread; Whisper/ffmpeg als Unterprozesse. So bleibt CPU-intensive Arbeit außerhalb des Web-Event-Loops, ohne einen zweiten Dienst einzuführen.
- HTTP-Abruf maximal 30 Sekunden, fünf Weiterleitungen, zehn MiB dekomprimierter HTML-Body. Jede Weiterleitung/DNS-Auflösung sicher behandeln. Zu große Inhalte sichtbar begrenzen statt abgeschnittenen Text als Volltext auszugeben.
- Keine pauschale tägliche Audio-Minutenquote oder Videolängengrenze im Standard. Viele Videos werden nacheinander abgearbeitet; Rückstand, Queue-Alter und geschätzten Durchsatz sichtbar machen. Ziel ist automatische Aufbereitung innerhalb von vier Stunden ab Import, einschließlich nachgelagerter Modellarbeit; siehe **F3**.
- Technische Schutzgrenzen bleiben nötig: Downloads/temporäre Audiodaten gegen ein konfiguriertes Speicherbudget und freien Platz prüfen, hängende Versuche zeitlich begrenzen. Bei erschöpftem Speicher sichtbar pausieren statt Platte füllen oder Artikel verwerfen. Große Audios bei Bedarf abschnittsweise verarbeiten; Grenzwerte anhand des Hosts festlegen, nicht aus einer gewünschten Videoanzahl ableiten.
- Temporäre Medien nach Abschluss/endgültigem Fehler bereinigen, verwaiste Dateien zusätzlich beim Start und zeitgesteuert entfernen. Checkpoints berücksichtigen, damit Wiederanlauf nicht unnötig fertige Arbeit verliert. Modellgewichte separat als reproduzierbaren Cache mit Version/Prüfsumme verwalten, nicht pro Video neu herunterladen.
- Container-RAM-Limit und Gesamtbudget für temporären Speicher nach Messung auf dem geteilten Host festlegen; keine ungemessene RAM-Garantie für Node, DOM, Whisper und andere Dienste behaupten.

## 6 · Container, Sicherheit und Betrieb

- Ein App-Image ohne Reverse Proxy, interner HTTP-Port; PostgreSQL extern. Nginx Proxy Manager/VPN bleiben Betreiberinfrastruktur. Keine Dienste, Ports oder Konfigurationen am vorhandenen Proxy automatisch verändern.
- Konfiguration für DB-Verbindung, öffentliche App-Origin, vertrauenswürdigen Proxy, Integrationsendpunkte und Secret-Quellen explizit bereitstellen. Keine pauschale Vertrauensfreigabe für beliebige Forwarded-Header oder fremde Origins/Hosts.
- Deployment-Secrets statt Secrets in Image, Git, API-Antworten oder Logs. Eigene Pi-Pfade, keine automatische Übernahme persönlicher Extensions/MCP-/Tool-Konfiguration. Medien-Unterprozessen nur benötigte Umgebungsvariablen geben.
- Mount-Vorschlag: `/data/pi-auth` und `/data/pi-sessions` für persistente Daten, `/data/models` als wiederherstellbarer Cache, eigener begrenzter temporärer Arbeitsbereich. App-UID benötigt passende Rechte; nicht als root betreiben.
- OAuth-Ersteinrichtung über den geplanten `setup-ai`-Befehl. Bei externer Neuanmeldung zunächst App-Neustart einplanen, bis ein sicherer Reload nachgewiesen ist; normale Token-Erneuerung übernimmt Pi. Keinen Docker-Socket in den Container einbinden.
- Geplanter separater Migrationsbefehl: geprüfte App-SQL-Migrationen und kontrolliertes pg-boss-Schema-Upgrade. Im normalen Webstart keine automatischen Schemaänderungen; bei inkompatibler Version nicht bereit melden.
- Paketversionen/Image-Digests festlegen. Aktuell unterstützte Node-LTS-/PostgreSQL-Versionen einsetzen; API-Angaben aus pg-boss-`master` vor Nutzung gegen die gewählte Releaseversion prüfen.
- JSON-Logs mit Request-/Lauf-/Task-ID und bereinigten Fehlercodes; keine Artikel-/Chat-Volltexte, Tokens oder unbereinigten URLs/Providerantworten loggen. Kein zusätzlicher Monitoring-Stack im ersten Wurf erforderlich.
- `/health/live` prüft den Prozess, `/health/ready` DB, kompatiblen Schema-Stand und notwendige Dateizugriffe. Keine kostenpflichtigen Modellaufrufe in Healthchecks; fehlende KI-Credentials dürfen nicht den gesamten Reader unbenutzbar machen.
- Bei SIGTERM neue Arbeit stoppen, begrenzte Grace Period für laufende Vorgänge, dann Unterprozesse kontrolliert beenden. Wiederanlauf anhand gespeicherter Schritte/Queue, keine verlorenen persönlichen Zustände.
- Backup-Startvorschlag: tägliche Sicherung durch den Betreiber, vor Migrationen zusätzlich sichern. Für einen einfachen konsistenten Schnitt App-Schreibzugriffe kurz stoppen, PostgreSQL konsistent sichern und Pi-Datenvolume erfassen; Credentials geschützt/verschlüsselt sichern. Modelle/temporäre Medien müssen nicht ins Nutzdatenbackup. Restore auf leerer Umgebung testen, nicht nur Backup-Erfolg zählen. Aufbewahrung und zulässiges Datenverlustfenster bleiben Betreiberfestlegungen.

## 7 · Nachweise und Tests

**Zuerst technische Risiken isoliert prüfen:**

1. Codex-Login im Container, persistenter Credential-Pfad, Neustart und Token-Erneuerung; JEV mit bestätigtem Provider/Modell für `choice`, `bool` und `score`, einschließlich Größen-/Fehlerverhalten.
2. Drizzle-Transaktion plus pg-boss-Auftrag gemeinsam committen/rollbacken; kein verlorener Folgeauftrag bei Absturz zwischen fachlicher Speicherung und Enqueue.
3. FreshRSS-Version/Pagination/Read-Markierung in isolierter Umgebung; Fehler nach DB-Commit, vor Bestätigung und während Pagination. Keine realen Favoriten-/Read-Zustände ohne separate Freigabe verändern.
4. Whisper auf Zielhardware mit deutschem/englischem Audio und realistischen langen Videos messen: Qualität, Laufzeit, RSS/RAM, temporärer Speicher und Reaktionsfähigkeit anderer Dienste. Danach eine repräsentative Vier-Stunden-Eingangsmenge einschließlich Untertitelabruf, Queue, Chunk-Aufbereitung, Kategorie, Tags und Scores testen. Pilotbudgets dürfen dabei nicht ungeprüft als passende Produktionslimits gelten. Erstimport/Altbestand zusätzlich als eigenen Lastfall erfassen, keine stillen Ausschlüsse oder Durchsatzgarantien annehmen. Modell jetzt nicht ungeprüft herunterladen oder als geeignet erklären.

**Während der Umsetzung:** Vitest als Testvorschlag für Geschäftsregeln; Integrationstests gegen echtes PostgreSQL statt SQLite für Constraints, Transaktionen, Locks und Migrationen. Playwright als Entwicklungstestwerkzeug für Desktop/mobile UI – kein Browser für die produktive Artikelbeschaffung. PWA-Installation zusätzlich auf echtem Smartphone prüfen.

Wesentliche Fälle: Mehrfachimport ohne State-Reset, ausstehende Bestätigungen, mehrgliedriger Tag-Merge und Rollback, Vote-Zeitverfall mit kontrollierter Uhr, leere/alte/fehlgeschlagene Scores, globale Sortierung und Nullwerte über mehrere Seiten, Budget-Rennen und Pausen, sichere HTTP-/Medienabrufe, Mail-Idempotenz, Karakeep-Fehler, SSE-Reconnect sowie vollständiger DB-/Pi-Session-Restore.

Zusätzliche Tests für die Kontextaufbereitung: sämtliche Chunks abgedeckt, Referenzen/Überlappungen korrekt, keine still verlorenen Inhalte, Budgetpause und Wiederanlauf, veraltete Generationen sowie Kennzeichnung verdichteter Scores. Einfache numerische Mittelung nicht als allgemeine Aggregationsregel verwenden.

## 8 · Entscheidungen und offene Kapazitätsdaten

### F1 · Import entkoppelt – bestätigt

Nur FreshRSS-Importläufe einschließlich Bestätigungskoordination global serialisieren. Ältere Artikeljobs dürfen begrenzt weiterlaufen, während ein späterer Import neue Artikel übernimmt. Keine Gesamtlauf-Sperre über wartende Modell-/Transkriptionsarbeit.

### F2 · TypeSafe direkt – bestätigt

`typesafe/jev-latest` mit `TYPESAFE_API_KEY`. Zugriff/Fehlerverhalten und tatsächliche Kontextgrenzen aus dem Container noch praktisch prüfen; keine Credentials im Dokument.

### F3 · Vier-Stunden-Ziel – bestätigt, Kapazität noch offen

Videos möglichst innerhalb von vier Stunden ab `imported_at` vollständig automatisch aufbereiten: Transkript, Qualitätsstatus, Kategorie, Tags und aktive Scores. Wartezeit in der Queue und Modellarbeit zählen mit, Zeit vor dem App-Import nicht; das FreshRSS-Pollintervall kommt vorher hinzu. Auf Anforderung erzeugte Zusammenfassungen und Chat gehören nicht zu diesem automatischen Ziel.

Viele Videos sind erwartete Nutzung, kein Grund für eine willkürliche Tages- oder Videolängenquote. Parallelitäts-, Speicher- und Hänger-Schutz bleiben erforderlich. Fertige, fehlgeschlagene, pausierte und nach vier Stunden noch wartende Videos getrennt ausweisen; Fehler nicht als Zielerreichung zählen.

Die Kapazitätsdaten werden im Pilot erhoben; dafür ist keine Vorabschätzung nötig. Erfasst werden Videostunden je Vier-Stunden-Zyklus, Anteil ohne brauchbare Untertitel, tatsächliche Transkriptionslast, CPU-Modell, lokaler Durchsatz, Queue-Wartezeiten und End-to-End-Zeiten bis zu den Scores. Anhand dieser Messungen lokale Transkription, Ressourcenprofil und Modellbudgets gegen das Vier-Stunden-Ziel bewerten. Für die serielle Transkription muss die nötige Audio-Rechenzeit in das Zeitfenster passen; zusätzlich bleiben Abruf, Queue und nachgelagerte Modellarbeit. Wenn Eingang dauerhaft größer als lokaler Durchsatz ist, wächst der Rückstand. Das Ziel ist daher keine bereits belegte Kapazitätszusage; gegebenenfalls mehr Rechenleistung oder ausdrücklich konfigurierte API-Transkription statt stiller Verzögerungsakzeptanz vorsehen.

### F4 · Automatische Segmentierung – bestätigt

Bei zu großem gewählten Modellkontext automatisch segmentieren und aufgabenbezogen verdichten/aggregieren, mit gespeicherten Zwischenständen und nachvollziehbarer Abdeckung. Zusätzliche Requests zählen mit; verdichtete Bewertungsgrundlage sichtbar machen. Kein blindes Abschneiden oder pauschaler Mittelwert von Chunk-Scores.

## Technische Recherchegrundlage – kein Integrationstest

- Installierte Pi-Dokumentation/Modellmetadaten auf Version 1.4.0: gemeinsame Modell-/Auth-Runtime, SDK-Sessions, Headless-OAuth und JEV-Classifier. Mehrere Provider bieten JEV an; nur die TypeSafe-Metadaten wurden für die genannte 64K-Angabe herangezogen.
- pg-boss dokumentiert [Drizzle-Transaktionsadapter](https://github.com/timgit/pg-boss/blob/master/docs/api/adapters.md), [Queue-Policies, Ablaufzeiten und Heartbeats](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md), [Migrationsverhalten](https://github.com/timgit/pg-boss/blob/master/docs/api/constructor.md) und [kontrollierte CLI-Migrationen](https://github.com/timgit/pg-boss/blob/master/docs/cli.md). Quellen auf beweglichem `master`, keine bereits gepinnte Abhängigkeit. Die dokumentierte Drizzle-Integration erlaubt gemeinsame Transaktionen; Queue-Policies allein garantieren keine fachliche Gesamtlauf-Sperre.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp#memory-usage): dokumentierte Größen sind Anhaltspunkte, keine Messung des geteilten Zielhosts.
