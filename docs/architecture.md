# Agentic News Reader – Architekturentscheidungen

**Status:** Architektur-Richtungsentscheidungen bestätigt. Technische Ausarbeitung und praktische Integrationsnachweise stehen aus; keine Implementierungsfreigabe. Noch zu prüfende Startvorschläge sind ausdrücklich gekennzeichnet.

Produktverhalten und Akzeptanzkriterien: [Produktspezifikation](dev-agentic-news-reader-spec.md). Diese Datei ergänzt sie um bestätigte technische Entscheidungen.

Datenmodell, API, Jobzustände, Pilotlimits und Prüfplan sind in der [technischen Skizze](technical-design.md) ausgearbeitet. Importentkopplung, direkter TypeSafe-JEV-Zugang und automatische Kontextsegmentierung sind bestätigt. Das Ziel für Videos ist eine automatische Aufbereitung innerhalb von vier Stunden ab Import. Weitere Mechanismen und numerische Pilotwerte bleiben Vorschläge; repräsentative Last und die dafür nötige Kapazität sind noch nachzuweisen.

## 1 · Systemzuschnitt und Betrieb

- Modularer Monolith nach Clean Architecture. Geschäftslogik bleibt unabhängig von UI, Persistenz und externen Adaptern.
- Ein App-Container; Web/API und Hintergrund-Runner laufen zunächst im selben Anwendungsprozess. PostgreSQL läuft separat.
- Zunächst nur den App-Container samt Einrichtungsweg liefern; kein eigener Reverse Proxy im Image oder als zusätzliche Infrastruktur. Vorhandener Nginx Proxy Manager übernimmt den HTTPS-Zugang.
- Fachliche Module für Import, Inhaltsaufbereitung, Bewertungen/Feedback, Reader, Integrationen und Chat.
- Offene Arbeit und Ergebnisse werden in PostgreSQL gespeichert. Kein zusätzlicher Queue-Dienst, kein Redis und keine Microservices.
- Medienwerkzeuge laufen als kontrollierte Unterprozesse; keine blockierende Verarbeitung im Web-Event-Loop.
- Bewusster Trade-off: Ein Absturz oder Neustart der Verarbeitung darf Reader und Chat kurz mit unterbrechen. Persistierter Zustand ermöglicht Wiederanlauf, bietet aber keine Hochverfügbarkeit.

## 2 · Sprache und Runtime

- TypeScript für Backend und UI.
- Node.js LTS als Serverruntime. Konkrete unterstützte Version bei Umsetzung festlegen und im Projekt fixieren.
- Geschäftslogik als frameworkunabhängige TypeScript-Module.
- Laufzeitvalidierung für externe Eingaben und Antworten; TypeScript-Typen allein reichen nicht.

## 3 · Frontend und PWA

- React als Single-Page-App, gebaut mit Vite; kein Next.js und kein serverseitiges Rendering vorgesehen.
- Tailwind CSS und shadcn/ui als Styling- und Komponentenbasis; übernommene Komponenten werden im Projekt gepflegt.
- Das Node-Backend liefert die gebaute UI und die API unter derselben Origin aus; kein separater Frontend-Container.
- Installierbare Progressive Web App (PWA), responsive für Desktop und explizit für mobile Darstellung und Bedienung optimiert.
- Dauerhafte Anwendungszustände bleiben serverseitig.
- Online-first: Nur das App-Grundgerüst wird lokal zwischengespeichert; ohne Verbindung erscheint ein klarer Offline-Hinweis. Kein dauerhafter lokaler Artikelcache und keine Offline-Schreibwarteschlange.
- Artikelzugriff, Chat und Aktionen benötigen eine Verbindung zum Server über das private VPN. PWA bedeutet nicht automatisch Push oder Hintergrundsynchronisation.
- Browserzugriff über HTTPS auch innerhalb des VPN; TLS-Terminierung am vorhandenen externen Nginx Proxy Manager. Der App-Container stellt intern HTTP bereit.

## 4 · Backend und API

- Fastify als HTTP-Framework.
- Schema-validierte HTTP/JSON-API mit definierten Antwortformaten; OpenAPI-Vertrag aus den API-Schemata ableiten.
- HTTP-Handler validieren Eingaben, rufen Anwendungsfälle auf und übersetzen Ergebnisse. Geschäftslogik und Hintergrund-Runner hängen nicht von Fastify ab.
- Eine dokumentierte HTTP-API für UI und externe Verbraucher, insbesondere die E-Mail-Integration. Kein zusätzlicher tRPC-API-Ansatz.
- HTTP für Aktionen, Server-Sent Events (SSE) für Chat-Ausgabe und Verarbeitungsfortschritt; keine WebSockets.
- Nach Verbindungsabbruch gespeicherten Zustand erneut laden. Keine Arbeit durch mobile Hintergrundunterbrechung verlieren; keine lückenlose Live-Zustellung versprechen.
- SSE über Nginx Proxy Manager praktisch prüfen; Proxy-Buffering und Timeouts berücksichtigen und Heartbeats vorsehen. Dies ist eine Betriebsanforderung, kein zusätzlicher mitgelieferter Proxy.

## 5 · Persistenzzugriff und Migrationen

- Drizzle ORM mit `pg` für den PostgreSQL-Zugriff.
- Tabellen, Beziehungen und Constraints in TypeScript beschreiben. SQL-Migrationen daraus erzeugen, prüfen und im Repository versionieren.
- Keine direkte Schema-Synchronisierung gegen die Produktionsdatenbank.
- SQL-nahe, typisierte Abfragen; explizites SQL bei Bedarf. Datenbankdetails bleiben im Persistenzadapter, nicht in der Geschäftslogik.
- Migrationen werden bewusst geprüft; automatische Erzeugung ersetzt keine Prüfung von Datenverlust, Sperren oder Transaktionsverhalten.

## 6 · Hintergrundjobs und Wiederanlauf

- pg-boss als PostgreSQL-basierte Jobbibliothek. Runner im gemeinsamen Node-Prozess, Queue in PostgreSQL; kein zusätzlicher Dienst.
- Import und Artikelverarbeitung in wiederholbare Schritte aufteilen. pg-boss übernimmt Ausführung, Zeitplanung und begrenzte Wiederholungen mit Backoff.
- Die Anwendung speichert fachlichen Fortschritt und fertige Ergebnisse unabhängig von der Ausführungsmechanik.
- Höchstens ein aktiver FreshRSS-Importlauf einschließlich Bestätigungskoordination. Ältere Artikeljobs dürfen begrenzt weiterlaufen, während ein späterer Import neue Einträge übernimmt; Budgetpausen und lange Transkriptionen blockieren nicht den nächsten Import.
- Dauerhafte Fehler bleiben sichtbar; keine endlosen automatischen Wiederholungen.
- Externe Modellaufrufe können nach einem Absturz doppelt erfolgen; kein Exactly-once-Versprechen.
- Eigene pg-boss-Tabellen und deren Migrationen berücksichtigen; Bibliotheksupgrades kontrolliert durchführen.

## 7 · Pi-Integration

- Direkte Pi-AI-Classifier-Aufrufe für Kategorie, Qualitätsprüfung und Scores. Dafür `typesafe/jev-latest` direkt bei TypeSafe mit `TYPESAFE_API_KEY` verwenden; Erreichbarkeit und Kompatibilität aus dem Container praktisch verifizieren. API-Key serverseitig bereitstellen, nicht über die Weboberfläche.
- Direkte reguläre Pi-AI-Modellaufrufe für freie Schlagwörter, Zusammenfassungen und benötigte Kontextverdichtung; keine Agenten-Session für diese Aufgaben.
- Bei zu großem Modellkontext automatisch segmentieren und aufgabenbezogen verdichten/aggregieren. Vollständige Inhalte erhalten, Abdeckung nachvollziehbar machen, Scores auf verdichteter Grundlage kennzeichnen. Kein blindes Abschneiden und kein pauschaler Mittelwert von Chunk-Scores; zusätzliche Aufrufe zählen gegen die passenden Budgets.
- Pi Coding-Agent SDK für Chat mit persistenten Sessions und für agentische Inhaltsextraktion.
- Standardwerkzeuge für Agenten deaktivieren; ausschließlich benötigte eigene Werkzeuge freigeben. Kein allgemeines Bash oder Dateisystemwerkzeug und kein direkter Secret-Zugriff.
- Gemeinsame Modell-/Providerkonfiguration und zentrale Anwendungslimits für beide Integrationswege. Direkte Modellaufrufe und SDK-Sessions müssen denselben Pi-Auth-/Modellruntime verwenden, damit OAuth-Auflösung und Token-Erneuerung nicht umgangen werden.
- Externe OAuth-Provisionierung einschließlich OpenAI Codex, ohne eigene Login-UI in der Anwendung. Ein administrativer Terminalbefehl mit Browser-Anmeldung ist als Einrichtungsweg akzeptiert.
- Kein Pi Durable zusätzlich; pg-boss übernimmt Jobausführung und Wiederholungen.
- Die dokumentierten Schnittstellen sind geprüft; konkrete Providerkompatibilität und Containerintegration bleiben praktisch zu verifizieren.

## 8 · OAuth-Einrichtung und persistente Dateien

- Geplanter, noch nicht implementierter Anwendungsbefehl: `docker compose run --rm -it app setup-ai`. Kein behaupteter bestehender Pi-CLI-Befehl.
- Der Einrichtungsbefehl zeigt den Anmeldelink; Anmeldung im normalen Browser. Falls der Callback den Container nicht erreicht, Redirect-URL beziehungsweise Code im Terminal einfügen. Device-Code-Login bevorzugen, sofern für das Konto verfügbar; dessen Verfügbarkeit ist nicht live geprüft.
- Dedizierten Pi-Credential-Speicher persistent bereitstellen und mit dem laufenden App-Prozess teilen. Token-Erneuerung dem gemeinsamen Pi-Runtime überlassen; dafür muss der Credential-Speicher beschreibbar sein. Keinen öffentlichen OAuth-Callback-Port voraussetzen.
- PostgreSQL speichert Artikeltexte, Transkripte, Zusammenfassungen, Bewertungen, Einstellungen und Jobs.
- Ein separates App-Datenvolume enthält Pi-Sessions und Credentials in getrennten Verzeichnissen. Kein vollständiges persönliches Pi-Verzeichnis einbinden.
- Heruntergeladene Audio-/Videodateien nur temporär speichern, mit Größen-/Laufzeitgrenzen und Bereinigung; kein dauerhaftes Medienarchiv.
- Backup und Restore umfassen PostgreSQL und das App-Datenvolume; Credentials besonders schützen. Login, Token-Erneuerung und Wiederherstellung im Container praktisch prüfen.

## 9 · Artikelaufbereitung

- Zunächst HTTP-Abruf und Mozilla Readability zur Haupttextextraktion, danach Qualitäts-Classifier. Kein JavaScript der Quellseite ausführen.
- Kein Headless-Browser im ersten Wurf. Agentischer Fallback nur für freigegebene Quellen mit eingeschränkten Recherche-/Abrufwerkzeugen.
- JavaScript-lastige oder anderweitig unzugängliche Seiten können unvollständig bleiben; diesen Zustand sichtbar machen statt Vollständigkeit zu behaupten.

## 10 · Video und lokale Transkription

- `yt-dlp` für vorhandene Untertitel beziehungsweise Audio, `ffmpeg` für Audioaufbereitung.
- Lokale CPU-Transkription bevorzugt; vier Kerne und 8 GB RAM stehen für die gesamte Maschine inklusive anderer Dienste zur Verfügung, nicht exklusiv für diese Anwendung. CPU-Modell und Architektur noch unbekannt.
- Konservativer Startvorschlag für den Benchmark: eine Transkription gleichzeitig mit zunächst zwei CPU-Threads; Reader und PostgreSQL benötigen weiterhin Ressourcen.
- Technischer Startvorschlag, noch zu benchmarken: `whisper.cpp` mit multilingualem Whisper `small`, gegebenenfalls quantisiert. Nicht das ausschließlich englische `.en`-Modell verwenden.
- Die [whisper.cpp-Dokumentation](https://github.com/ggml-org/whisper.cpp#memory-usage) nennt für `small` etwa 852 MB Speicherbedarf; dies ist kein gemessener Gesamtbedarf dieser Anwendung und keine Laufzeitgarantie für die Zielhardware.
- Keine pauschale tägliche Audio-Minutenquote oder Videolängengrenze im Standard. Viele Videos führen zu einer sichtbaren Queue; Parallelität, temporären Speicher und hängende Prozesse weiterhin begrenzen. Optionale Nutzungslimits bleiben konfigurierbar.
- Ziel: innerhalb von vier Stunden ab dauerhafter Übernahme in die App Transkript, Qualitätsstatus, Kategorie, Schlagwörter und aktive Scores bereitstellen. Wartezeit bis zum FreshRSS-Import kommt vorher hinzu. Queue-Wartezeit und Modellarbeit zählen zum Ziel; lokale Machbarkeit ist noch nicht belegt.
- API-Transkription bleibt eine Alternative, falls lokale Laufzeit oder Qualität nicht ausreichen. Kein stillschweigender Wechsel mit Kosten oder Audio-Datenweitergabe; nur nach expliziter Konfiguration.
- Codex OAuth bedeutet nicht automatisch Zugriff auf eine allgemeine OpenAI-Transkriptions-API.

## 11 · Netzwerkgrenzen

- Artikelabruf und Agenten-Seitenabruf nur zu öffentlichen HTTP(S)-Zielen. Private Netze, localhost und Cloud-Metadaten sperren; Weiterleitungen dürfen diese Grenze nicht umgehen.
- FreshRSS, Karakeep, PostgreSQL und lokale Modellendpunkte bleiben über separat konfigurierte Integrationen erreichbar. Fremde Artikel und Agenten-URLs dürfen diese Freigaben nicht mitbenutzen.
- Durchsetzung einschließlich DNS-Auflösung, Weiterleitungen und Medienwerkzeugen praktisch prüfen; eine URL-Prüfung nur am Anfang ist kein ausreichender Sicherheitsnachweis.

## 12 · Nutzungsgrenzen und Budget-Pausierung

- Getrennte konfigurierbare Grenzen für automatische LLM-Aufrufe, interaktive Nutzung, Classifier und lokale Transkription.
- Bei unbekannten Kosten Aufruflimits und, soweit verfügbar, Token-Nutzung verwenden. Audio-Minuten für lokale Transkription erfassen und optional begrenzen, aber keine feste tägliche Minutenquote voraussetzen. Wiederholungen zählen mit.
- Offene Arbeit bei ausgeschöpftem Budget sichtbar pausieren, nicht verlieren. Keine Eurogarantie bei unbekannten Kosten; unbekannte Kosten nicht als null anzeigen.
- Konkrete Startwerte vor einem größeren Erstlauf festlegen. Diese Entscheidung legt das Verfahren fest, noch keine numerischen Default-Budgets.

## 13 · Zeitverfall der Präferenzgewichte

- Kontinuierlicher exponentieller Verfall: `Gewicht = manueller Offset + Summe(Vote * 2^(-Alter_in_Tagen / Halbwertszeit_in_Tagen))`.
- Halbwertszeit konfigurierbar, Default 90 Tage. Drei Monate bedeuten hier drei mal 30 Tage, nicht Kalendermonate. Ein Tag entspricht 24 Stunden vergangener Zeit.
- Nach 90 Tagen zählt ein unveränderter Vote halb, nach 180 Tagen ein Viertel. Neutrale Votes tragen null bei; der manuelle Offset altert nicht.
- Rohgewichte nicht stillschweigend kappen oder durch Anzeigeformatierung Rankings verändern.

## Ausstehende technische Ausarbeitung

- Datenmodell, Constraints, Transaktionsgrenzen und Indizes anhand der Produktspezifikation konkretisieren.
- HTTP-Routen, Schemas, Fehlerformate und Pagination festlegen; bestehende Idempotenz- und globale Sortieranforderungen erhalten.
- Arbeitszustände, Import-Sperre, Retry-/Parallelitätswerte, Budgetzählung und Pausierung konkretisieren; keine konkurrierenden FreshRSS-Importläufe oder verlorene Arbeit zulassen.
- Konkrete Paketversionen, Codex-Modell-ID, numerische Modellbudgets und Ressourcen-/Dateigrenzen festlegen. CPU-Modell und Architektur des Zielhosts ermitteln; TypeSafe/JEV-Referenz ist bereits entschieden.
- Container-Konfiguration, Origin-/Host- und Proxy-Vertrauensgrenzen, Betriebsdiagnostik sowie Backup-/Restore-Abläufe ausarbeiten. Kein eigener Reverse Proxy im Lieferumfang.

## Ausstehende praktische Nachweise

- Codex OAuth einschließlich Headless-Einrichtung und Token-Erneuerung sowie JEV-Classifier aus dem Container testen; keine Credentials in Logs, Browser oder Repository.
- Transaktionale Integration von pg-boss und Drizzle, Wiederanlauf und idempotente FreshRSS-Übernahme inklusive Pagination und Bestätigung prüfen. Tatsächliche FreshRSS-Version und bestehenden Favoriten-Workflow berücksichtigen.
- Lokale Transkription auf dem geteilten Zielhost mit repräsentativem deutschem und englischem Audio benchmarken: Qualität, Laufzeit, Speicherbedarf und Auswirkungen auf Reader/andere Dienste. Mit tatsächlicher Video-/Audiomenge und Untertitelanteil das Vier-Stunden-Ziel inklusive Queue und nachgelagerter Modellarbeit prüfen; `whisper.cpp`/Modellprofil erst danach abschließend festlegen.
- Extraktion, Karakeep-Semantik, Netzwerkgrenzen, mobile/PWA-Bedienung und SSE über vorhandenen Nginx Proxy Manager prüfen.
- Neustart und konsistentes Backup/Restore von PostgreSQL und App-Datenvolume einschließlich fortsetzbarer Pi-Sessions nachweisen. Testabdeckung an den Akzeptanzkriterien der Produktspezifikation ausrichten.
