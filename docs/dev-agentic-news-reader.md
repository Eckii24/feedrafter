# Agentic News Reader – Ausgangspunkt für die Spec-Session

[[dev]] · Verwandt: [[org-private-tooling-hermes-integration]]

**Status:** Discovery / Spec zur Prüfung. Die aktuelle Produktspezifikation steht in [[dev-agentic-news-reader-spec]]; diese Seite bewahrt Gesprächskontext und historische Zwischenstände. Keine Implementierungsfreigabe.

## Ziel und Anlass

Matthias möchte relevante Nachrichten, RSS-Inhalte und Videos mit weniger eigenem Sichtungs- und Leseaufwand verarbeiten. Der Engpass ist nicht das Erstellen weiterer Zusammenfassungen, sondern die verfügbare Zeit und die Auswahl dessen, was tatsächlich Aufmerksamkeit verdient.

Heute werden FreshRSS-Favoriten durch einen bestehenden Hermes-Job verarbeitet: Ausgewählte Inhalte werden zusammengefasst und per E-Mail zugestellt; Audios sind Teil der Ausgabe. Beim betrachteten Lauf wurden sieben Artikel in zwei E-Mail-Chunks zugestellt. Die manuelle Vorauswahl und das anschließende Lesen der Zusammenfassungen bleiben dennoch Aufwand. Ein gesendeter Digest bedeutet nicht, dass er gelesen wurde.

**Gewünschtes Ergebnis:** Eine persönlich anpassbare News-Anwendung mit eigener ansprechender Oberfläche, die FreshRSS-Inhalte mit agentischer Bewertung und Zusammenfassungen kombiniert, um schneller entscheiden zu können, was wichtig ist und was vertieft werden soll. Die genaue Definition von Erfolg, Erstumfang und Abschlusszustand ist noch offen.

## Session-Zwischenstand vom 2026-10-31

Dieser Abschnitt hält den laufenden Grill-Me-Zwischenstand fest und hat Vorrang vor älteren, widersprechenden Ideen oder offenen Punkten auf dieser Seite. Er ist keine fertige Spec und keine Implementierungsfreigabe.

### Ziel und erster Wurf

- Hauptziel: schnell interessante Inhalte erkennen und gezielt vertiefen; keine automatische Ausfilterung oder Löschung nach niedrigem Score.
- Eigenständige Web-App für Desktop und Smartphone, privat selbst gehostet; FreshRSS bleibt Feed-Aggregator. Pi ist die KI-Integrationsschicht. Pi SDK oder Pi Durable und der konkrete Stack sind noch nicht entschieden; TypeScript liegt nahe.
- Erster Wurf umfasst Artikel und Videos, Import und Aufbereitung, Bewertungen, Reader-UI, Zusammenfassung, E-Mail-Queue/API, Karakeep-Aktion, Chat und persönliches Feedback. Erweiterbarkeit ist wichtig; ein generisches Plugin-System wurde nicht beschlossen.
- Der bestehende FreshRSS-Favoriten-E-Mail-/Audio-Workflow läuft zunächst unverändert parallel. Eine spätere Ablösung ist nicht entschieden; seine Verträglichkeit mit dem neuen Lesestatus muss geprüft werden.

### Import, Inhalt und Verarbeitung

- Beim ersten und bei folgenden Läufen alle ungelesenen FreshRSS-Einträge übernehmen. Nach dauerhaft erfolgreicher Übernahme ausschließlich diese in FreshRSS als gelesen kennzeichnen: Dort bedeutet gelesen künftig technisch übernommen, nicht tatsächlich gelesen. Der eigene Lesestatus ist unabhängig. FreshRSS-ID für Deduplizierung; keine automatische Zusammenführung gleicher URLs oder ähnlicher Geschichten im ersten Wurf.
- Titel, URL, Feed/Quelle, FreshRSS-ID sowie – soweit vorhanden – Autor und Datum speichern. Inhalt lieber am Original beschaffen als den FreshRSS-Body übernehmen. Artikel zunächst deterministisch abrufen/extrahieren, ein Classifier schätzt die Qualität; bei Bedarf agentische Nachbearbeitung. Agentischer Fallback läuft automatisch nur für explizit freigegebene Quellen; YouTube ist standardmäßig freigegeben.
- Videos: erst verfügbares Transkript/Untertitel beschaffen; falls nicht verfügbar, Audio automatisch herunterladen und transkribieren. Geeignete Werkzeuge wie yt-dlp und Transkriptionsmodell noch festlegen. Fehlgeschlagene oder unvollständige Inhalte bleiben mit Status und Retry sichtbar; keine erfundene Zusammenfassung oder vorgetäuschte Vollständigkeit. Bewertungen auf unvollständiger Basis gegebenenfalls eindeutig kennzeichnen.
- Automatischer Lauf standardmäßig alle vier Stunden, konfigurierbar/abschaltbar, plus manueller Start. Höchstens ein Lauf gleichzeitig; manuelles Triggern zeigt den bestehenden Lauf. Fortschritt und Fehler sichtbar.
- Einfacher Wiederanlauf: aktuellen Stand und Ergebnisse in einer DB speichern; abgeschlossene Ergebnisse erhalten, offene Schritte nach Neustart gegebenenfalls erneut ausführen. Keine aufwendige Durable Execution nur um ihrer selbst willen. Details zu Fehlerfällen, Importbestätigung und Wiederholung noch ausarbeiten.

### Kategorien, Scores und persönliches Feedback

- Acht konfigurierbare Startkategorien: KI & Agenten; Softwarearchitektur & Engineering; Entwicklerwerkzeuge & Plattformen; Homelab, DevOps & Smart Home; Produktivität & Wissensmanagement; Haus & Wohnen; Gesundheit & Fitness; Hobbys & Allgemeinwissen. Grundlage ist die lesend abgefragte FreshRSS-Abo-Liste vom 2026-10-31. „Nicht zugeordnet“ ist ein technischer Fallback.
- Classifier weist genau eine Kategorie zu oder wählt bei Unsicherheit „Nicht zugeordnet“. Manuelle Korrektur pro Artikel; Neubewertung bei Bedarf per Button, nicht automatisch.
- Scores sind in den Settings als Liste konfigurierbar: Name, Beschreibung, Prompt, aktiver Status, optionale Prompt-Overrides je Hauptkategorie und wählbare Kontextbestandteile wie Titel, Inhalt, Kategorie, Schlagwort- und Quellengewicht. Einheitliche Skala 0–100, keine Begründung erforderlich. Start-Scores: Hype, Facts, Signal und persönliche Relevanz; nur persönliche Relevanz nutzt standardmäßig Schlagwort- und Quellengewichte. Facts ist keine unabhängige Faktenprüfung; Signal und persönliche Relevanz sind unterschiedliche Dimensionen.
- Je Score getrennte Checkboxen für Schlagwortgewichte und Quellengewicht: Nur die zum aktuellen Artikel gehörenden Gewichte gehen als Kontext in den Classifier; kein zusätzlicher fest verdrahteter Multiplikator. Bei fehlendem Score diesen als unbewertet anzeigen und beim Sortieren hinter bewertete Artikel setzen.
- Prompt-/Modelländerungen wirken auf zukünftige Bewertungen; keine Speicherung der verantwortlichen Konfigurationsversion und keine automatische Massen-Neubewertung. Ein neu angelegter Score wird für neue Artikel berechnet; frühere bleiben unbewertet, bis explizit neu bewertet wird. Eine manuelle Neubewertung berechnet immer alle aktiven Scores des Artikels.
- Scores werden ausschließlich per Soft Delete entfernt; ihre bisherigen Werte bleiben gespeichert, aber entfernte Scores erscheinen nicht mehr in der Liste oder Sortierung. Kein Hard Delete für Scores. Falls der Standard-Sortierscore entfernt wird, Fallback auf Datum.

### Schlagwörter und Präferenzgewichtung

- Schlagwörter sind von der einen Hauptkategorie getrennt: Ein KI-Modell vergibt nach der Inhaltsaufbereitung und vor den Scores bevorzugt fünf bis zehn, maximal zehn Schlagwörter je Artikel; weniger bei mangelndem sinnvoll verwendbarem Inhalt. Bestehenden Katalog bevorzugen, neue Schlagwörter nur bei Bedarf ergänzen. Fehlender Inhalt: ausstehend oder eingeschränkt markieren. Separat konfigurierbarer Classifier, sofern dessen Ausgabe neue freie Schlagwörter technisch unterstützt; Machbarkeit noch prüfen.
- Schlagwörter sind am Artikel manuell ergänz- und entfernbar. Beim Entfernen einer Zuordnung vorhandenes Feedback nicht stillschweigend löschen: Bereits bewertete Ziele müssen am Artikel weiterhin auffindbar und korrigierbar bleiben.
- 👍/👎 öffnet eine Zielauswahl: eines oder mehrere Schlagwörter des Artikels und/oder seine Quelle auswählen; die Richtung gilt für alle gewählten Ziele. Kein allgemeines Voting auf Artikelebene. Stimme je Artikel und Schlagwort beziehungsweise Quelle: +1, 0 oder −1; ändern und entfernen möglich. Jede Voting-Aktion aktualisiert das Vote-Datum, nicht das Artikeldatum. Feedback ändert vorhandene Scores nicht automatisch.
- Das aktuelle Gewicht eines Schlagworts bzw. einer Quelle ergibt sich aus der Summe seiner zeitlich gewichteten Artikel-Votes plus manuellem Offset. Neuere Votes zählen stärker; Zeitverfall ist konfigurierbar, Formel und Default noch offen. Der manuelle Offset altert nicht. Settings zeigen Quellen und Schlagwörter mit Up-/Down-Zahlen und Gewicht; Gewicht manuell über Offset beeinflussbar.
- Settings-Seite zum Auswählen und Kombinieren mehrerer Schlagwörter: Artikelzuordnungen auf das Ziel umstellen, Votes übertragen, manuelle Offsets addieren und Gewichte neu berechnen; alte Schlagwörter dürfen danach hart gelöscht werden. Hatte ein Artikel mehrere der zusammengeführten Schlagwörter, bleibt genau ein Vote: Summe aller beteiligten Werte bilden und Vorzeichen nehmen (+/+ → +, +/− → 0, +/0 → +; entsprechend für weitere Kombinationen). Bei mehr als zwei Votes gemeinsam aggregieren, nicht reihenfolgeabhängig paarweise. Datum des resultierenden Votes ist das neueste beteiligte Vote-Datum, nicht der Merge-Zeitpunkt.

### UI, Aktionen und Chat

- Einträge möglichst unmittelbar nach Import mit Verarbeitungsstatus anzeigen. Standardansicht ungelesen; Standardsortierung Signal absteigend, fehlende Scores danach sichtbar. Global korrekte Sortierung, nicht nur lokal auf der geladenen Seite. Weitere Sortierung nach Scores, Datum und gegebenenfalls Titel.
- Filter nach Kategorie, Quelle, gelesen/ungelesen, Artikel/Video und Verarbeitungsstatus; Textsuche nach Titel. Gelesene bleiben auffindbar und können wieder ungelesen werden; keine automatische Löschung im ersten Wurf.
- Zusammenfassung per Klick mit konfigurierbarem Prompt; beim Artikel speichern. Explizites erneutes Zusammenfassen ersetzt die vorherige Fassung.
- Karakeep-Button speichert ausschließlich die Original-URL; Karakeep-URL und Token sind konfigurierbar. Kein automatischer Massenimport und kein neuer Tag oder Status beschlossen.
- Pi-Chat direkt im ersten Wurf; Sessions und Laden über Pis eigenes Session-Management. Copy-to-Chat fügt interne Referenzen zu einem oder mehreren Artikeln in das Eingabefeld ein, ohne automatisch abzusenden. Chat darf gespeicherte referenzierte Inhalte und dedizierte lesende Websuche/Seitenabruf nutzen, aber keine Artikelzustände ändern, kein allgemeines Bash und keinen direkten Tokenzugriff erhalten; Tool-Aufrufe und Laufzeit begrenzen.

### E-Mail, Modelle und Limits

- E-Mail-Status: nicht vorgesehen, vorgemerkt, gesendet. API zum Abruf vorgemerkter, nicht gesendeter Artikel; externe Verarbeitung bestätigt nach erfolgreichem Versand explizit die IDs. Die App versendet nicht selbst. Fehlgeschlagene Bestätigungen und mögliches doppeltes Versenden sind beim API-Vertrag zu behandeln.
- Modelle je Aufgabentyp in Settings konfigurierbar, mindestens Kategorie-/Qualitäts-/Schlagwort-/Score-Classifier, Extraktionsagent, Zusammenfassung, Chat und Transkription; mehrere Aufgaben dürfen dieselbe Konfiguration nutzen. Ein optional konfiguriertes Pi-Fallback-Modell darf verwendet werden; ohne explizites Fallback keine Ausweichroute. Tatsächliche Datenweitergabe abhängig vom konfigurierten Modellanbieter.
- Classifier-Aufrufe dürfen häufig und günstig sein; teurere LLM-Aufrufe gezielt begrenzen. Separate konfigurierbare Budgets für automatische LLM-Verarbeitung, interaktive Nutzung und Transkription; Classifier separat. Bei Erreichen pausiert die jeweilige Verarbeitung und offene Arbeit bleibt erhalten. Kostenlimits, soweit verlässliche Kosten verfügbar, ansonsten ergänzende Aufruf-/Nutzungslimits. Konkrete Werte und technische Durchsetzung offen.

### Noch offen / nächste Gesprächsfront

- IndyDevDan-Vorrecherche: Im [Referenzcode](https://github.com/disler/pi-durable-news-agent/blob/273b79bb8d3d8907cae9fbd6abd3da163ee2a343/apps/dna-server-api/src/news/taste.ts) ändern 👍/👎 Themen- und Quellengewichte; bis zu sechs aktuelle Feedbackbeispiele (Titel und Feedback) gehen in Classifier-Kontext ein. [Ranking](https://github.com/disler/pi-durable-news-agent/blob/273b79bb8d3d8907cae9fbd6abd3da163ee2a343/apps/dna-server-api/src/news/rank.ts) multipliziert Wichtigkeit mit Themen-, Quellen- und Aktualitätsfaktor. Kein Modell-Fine-Tuning. Übertragung auf diesen Reader bleibt offen; pauschale Quellenabwertung kann aus einem einzelnen schlechten Artikel folgen.
- Konkrete Zeitverfallsfunktion und Defaults, Behandlung neutraler Votes und Zeitstempel beim Merge, Grenzen und Darstellung großer Gewichte sowie technisch unterstützte Classifier-Ausgabe für neue Schlagwörter.
- Feinheiten der dynamischen Score-Konfiguration und Score-Ausführung, insbesondere tatsächliche Kontextgrenzen und Anzahl der Classifier-Aufrufe.
- Konkrete Standardprompts, Modelle, Quellenfreigaben, Limits, Tool-/Provider-Datenschutz, Deployment/Authentifizierung, Backup sowie API-Verträge.
- Betriebsrealität und Kompatibilität des bestehenden Digest-Jobs nach FreshRSS-Lesestatusänderungen read-only prüfen; keine Dienste, Tasks oder Warteschlangen im Rahmen dieser Session ändern.

## Getroffene Richtungsentscheidungen

- **Neue Anwendung von Grund auf:** Open-AIRSS wird nicht als Basis weiterverfolgt. Es soll eine neue Anwendung entstehen, die für den gewünschten Workflow und die gewünschte Oberfläche entworfen wird.
- **FreshRSS als Backend-Basis:** FreshRSS bleibt zunächst Quelle für Feeds und Artikel. Eine eigene Oberfläche soll darauf aufbauen, statt FreshRSS lediglich per Extension visuell umzubauen. Welche weiteren Daten und Zustände FreshRSS verbindlich besitzt, ist noch zu definieren.
- **Eigene UI ist wichtig:** Nicht nur ein Digest oder eine API. Matthias möchte eine Oberfläche, die ihm gefällt und die sich funktional und visuell anpassen lässt. IndyDevDans News-Agent ist eine Inspiration, keine verbindliche 1:1-Vorlage.
- **Leichte Erweiterbarkeit als Ziel:** Neue Funktionen und Integrationen sollen ähnlich angenehm hinzufügbar sein, wie Matthias es bei Pi-Extensions schätzt. Was technisch als Extension gilt und wie diese geladen, konfiguriert und abgesichert werden, ist noch nicht entschieden.
- **Bring your own agent / model:** Pi und unterschiedliche Modelle sollen eingebunden werden können. Die genaue Abstraktion und welche Laufzeiten zwingend unterstützt werden müssen, sind noch offen.
- **Spec-Session vor Umsetzung:** Diese Seite dient als gemeinsamer Ausgangspunkt. Produktverhalten und Grenzen werden noch detailliert besprochen.

## Bestehender Kontext und Grenzen

- FreshRSS enthält laut bisheriger Bestandsaufnahme 129 Feed-Abos. Diese Zahl ist eine Momentaufnahme, keine dauerhafte Anforderung.
- Die lokale Compose-Konfiguration nennt FreshRSS `1.28.1`; die tatsächlich laufende Version wurde nicht bestätigt.
- Ein FreshRSS-Favorit ist im bestehenden Digest-Workflow ein Verarbeitungssignal. Nach bestätigter Zustellung wird er dort entmarkiert. Das ist nicht gleichbedeutend mit „gelesen“ oder „dauerhaft speichern“.
- Karakeep dient als bewusst kuratierte Lese-/Bookmark-Ablage. Ein bestehender separater Workflow verarbeitet Karakeep-Favoriten zu Wiki-Notizen; nicht dieselbe Bedeutung wie FreshRSS-Favoriten unterstellen.
- Die neue Anwendung soll diese bestehenden Zustands- und Automationsverträge nicht stillschweigend verändern. Ob und wie der bisherige Digest langfristig ersetzt wird, ist offen.
- Heimserver und VPS wurden als mögliche Betriebsorte besprochen. **Ein Umzug ist nicht entschieden.** Die lokale Konfiguration allein belegt nicht die tatsächliche Erreichbarkeit oder Absicherung der laufenden Dienste.

## Gewünschte Fähigkeiten

### Informationen sammeln und auswählen

- FreshRSS als Quelle für bestehende Feeds und Artikel nutzen; nicht zuerst den kompletten Feed-Bestand migrieren müssen.
- Die Flut vor der menschlichen Aufmerksamkeit vorfiltern und priorisieren, statt erst nach manueller Auswahl detaillierte Zusammenfassungen zu erzeugen.
- Verschiedene Ansichten und Sortierungen nach Bewertungen ermöglichen. Eine globale Sortierung muss – falls gewünscht – tatsächlich über die relevante Ergebnismenge funktionieren, nicht nur über die gerade geladene Seite.
- Eine chronologische bzw. ungefilterte Sicht und Wiederauffindbarkeit übersehener Inhalte sind sinnvolle Sicherheitsnetze; konkrete Anforderungen noch abstimmen.
- Ähnliche Meldungen zusammenführen / Story-Deduplizierung wurde als Idee besprochen. Ob und wann dies Pflicht ist, ist offen.

### Bewertung: Hype, Facts und Signal

Inspiration ist [IndyDevDans Pi Durable News Agent](https://github.com/disler/pi-durable-news-agent): drei unabhängige Scores **Hype, Facts, Signal** je Inhalt, im Referenzprojekt auf einer Skala von 0–100. Die Werte müssen nicht zusammen 100 ergeben.

- **Hype:** Wie übertrieben, werblich oder substanzarm wirkt ein Inhalt?
- **Facts:** Wie überprüfbar erscheinen Aussagen anhand der vorhandenen Quellen und Details? Ein hoher Wert ist **kein Nachweis unabhängiger Faktenprüfung**.
- **Signal:** Wie nützlich und konkret anwendbar ist der Inhalt für den Leser?

Die ursprüngliche [HFS-Definition](https://github.com/disler/pi-durable-news-agent/blob/273b79bb8d3d8907cae9fbd6abd3da163ee2a343/apps/dna-server-api/prompt_engineering/jev/hfs/command.json) bewertet Signal speziell für Engineers, die AI-Agents bauen. Für Matthias müssen Interessen, Kriterien und gegebenenfalls unterschiedliche Themenkontexte noch definiert werden. Zahlen sollten nachvollziehbar sein, nicht als objektive Wahrheit erscheinen.

Gewünscht sind diese drei Felder sichtbar an Artikeln und zusätzliche Sortierungen anhand solcher Werte. Offen: genaue Platzierung, Scoring-Zeitpunkt, Begründungen, Skalen, Filter, weitere Scores und Umgang mit fehlgeschlagenen oder noch nicht bewerteten Inhalten.

### Pi, Modelle und Agenten

- Pi-Classifier-Modelle sollen für strukturierte Bewertungen nutzbar sein; normale Modelle für Zusammenfassungen und gegebenenfalls weiterführende Aufgaben.
- Die [Pi-Classification-API](https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md) erlaubt einen direkten programmgesteuerten Classifier-Aufruf ohne vollständige Coding-Agent-Session. Ein normales Chatmodell ist nicht automatisch ein Classifier.
- Im lokalen Pi-Setup existiert bereits ein Classifier-Adapter für konfigurierte TypeSafe-/llama.cpp-Backends. Daraus folgt nicht, dass jedes Modell automatisch auf jedem Host verfügbar oder freigeschaltet ist.
- Eine volle Agenten-Session ist für einfache Bewertung oder Zusammenfassung nicht zwingend nötig; für Recherche oder toolgestützte Arbeit kann sie relevant sein. Die konkrete Nutzung ist zu entscheiden.
- Bring-your-own-agent bedeutet als Ziel nicht, dass beliebige Agenten bereits integriert sind. Vertrag, Konfiguration, Fähigkeiten und Sicherheitsgrenzen müssen noch definiert werden.
- Mögliche Optimierung, **noch keine Entscheidung**: günstige Triage anhand vorhandener Metadaten; nur ausgewählte Inhalte mit Originaltext bzw. Video-Transkript vertieft verarbeiten.

### Interaktion und Aktionen pro Artikel

- Zusätzliche Aktionen pro Artikel sind gewünscht, insbesondere **Karakeep** sowie das Anstoßen von Modellverarbeitung / Zusammenfassungen.
- Diskutierte weitere Ideen, noch nicht beschlossen: neu bewerten, „mehr / weniger davon“, Artikel mit einem Agenten besprechen, Quellen oder Originalinhalt öffnen.
- Karakeep soll eine bewusste Auswahl unterstützen; nicht den gesamten Feed-Strom automatisch als Bookmarks übernehmen.
- Offen: exakte Buttons, Standardaktionen, Feedback-Semantik, Tastaturbedienung, Status- und Fehleranzeigen.

### Oberfläche und Erweiterbarkeit

- Eigene UI statt Anpassung an die Grenzen der FreshRSS-Oberfläche; visuell und funktional am tatsächlichen Workflow orientiert.
- Wiederkehrende Erweiterungen sollen leicht möglich sein, etwa neue Sortierungen, Bewertungen, Buttons, Ansichten, Integrationen oder Agentenfähigkeiten.
- Offen: Desktop-/Mobile-Priorität, Layout, Karten vs. Liste, Informationsdichte, konkrete Interaktionsmuster und wie Extensions aus Nutzersicht entstehen und verwaltet werden.
- Eine schöne Oberfläche allein ist nicht das Ziel: Sie soll Zeit und Aufmerksamkeit sparen, nicht eine neue Queue erzeugen.

## Technische Erkenntnisse aus der Vorrecherche

Diese Punkte sind Rechercheergebnisse und Entwurfsannahmen, keine bereits implementierten Eigenschaften der neuen Anwendung.

- [FreshRSS-Extensions](https://freshrss.github.io/FreshRSS/en/developers/03_Backend/05_Extensions.html) erlauben Hooks, eigene Controller/Views sowie JavaScript/CSS. Die [Karakeep-Button-Extension](https://github.com/veverkap/xExtension-karakeep-button) demonstriert eine Aktion pro Artikel. Eine FreshRSS-Extension wäre für Anzeige und Buttons grundsätzlich möglich gewesen.
- Die [FreshRSS-1.28.1-Abfragelogik](https://github.com/FreshRSS/FreshRSS/blob/1.28.1/app/Models/EntryDAO.php) verwendet feste Sortierkriterien vor der Pagination. Ein bloßes Umsortieren sichtbarer DOM-Elemente liefert kein global korrektes Score-Ranking.
- Auch eine eigene UI löst globale Sortierung **nicht automatisch**: FreshRSS liefert paginierte Daten. Ein scorefähiger Index oder ein anderer korrekt definierter Abfrageweg wäre zu entwerfen, falls globales Ranking benötigt wird.
- Möglicher Architekturansatz, **nicht beschlossen**: FreshRSS für Feed-/Artikel-Daten; ein eigener Dienst für Bewertungen, Hintergrundverarbeitung und scorefähige Abfragen; eine eigene Web-UI. Zustandsgrenzen, Datenmodell und Integration bleiben Gegenstand der Spec-/Architekturdiskussion.
- Originalartikel, Feed-Inhalte, Video-Transkripte und Modellantworten sind nicht vertrauenswürdig. Bei Agenten mit Tools und insbesondere bei VPS-Betrieb müssen Berechtigungen, externe Inhalte, Secrets, Inhaltsdarstellung und Modell-Datenabfluss explizit betrachtet werden.
- Lokales Hosting bedeutet nicht automatisch lokale Inferenz: Der konfigurierte private Classifier kann Daten an einen externen Provider senden.
- Recherche und Codeinspektion waren überwiegend dokumentations- und quellenbasiert. Keine neue Anwendung, kein Live-Integrations- oder Sicherheitstest und kein FreshRSS-/Karakeep-Write wurden durchgeführt.

## Offene Entscheidungen für die Spec-Session

Nicht alle Fragen müssen für Version 1 beantwortet oder implementiert werden.

1. **Erfolg und Nutzung:** Wann und wie häufig soll Matthias die Anwendung nutzen? Welche konkrete Entscheidung soll nach kurzer Sichtung leichter sein? Woran merken wir, dass sie Zeit spart?
2. **Erster Produktumfang:** Was muss die erste nutzbare Version können und was ist später? Was passiert mit dem bestehenden E-Mail-/Audio-Digest?
3. **Quellen und Inhalte:** Welche Feeds, Artikeltypen, Videos und Transkripte sind relevant? Wie wird mit fehlendem Volltext umgegangen?
4. **Priorisierung:** Sind alle drei Scores für jedes Item erforderlich? Welche persönlichen Interessen und Kriterien definieren Signal? Wie werden Ergebnisse erklärt, neu bewertet und bei fehlgeschlagener Verarbeitung dargestellt?
5. **Sortierung und Auswahl:** Welche Sortierungen und Filter sind erforderlich? Welche Artikelmenge gilt als global? Wie bleiben unbewertete oder falsch niedrig bewertete Inhalte erreichbar?
6. **UI und Interaktionen:** Welche Geräte und Ansichten zuerst? Wie sehen Artikelliste, Detailansicht, Zusammenfassungen, Aktionen und Fehlerzustände aus?
7. **Karakeep und Status:** Welche explizite Aktion speichert einen Artikel? Wie verhalten sich gelesen, ungelesen, FreshRSS-Favorit, verarbeitet, zugestellt und in Karakeep gespeichert zueinander?
8. **Agenten und Erweiterungen:** Was soll ein Dritter bzw. Matthias selbst ohne Änderung des Anwendungskerns hinzufügen können? Welche Agenten- und Modelladapter sind anfangs erforderlich? Wo liegen Sicherheits- und Berechtigungsgrenzen?
9. **Verarbeitung und Kosten:** Automatisch, geplant oder auf Anfrage? Welche Grenzen für Modellkosten, Latenz, Wiederholungen und Datenweitergabe gelten?
10. **Betrieb und Daten:** Heimserver, VPS oder getrennte Komponenten? Wie erfolgen Zugang, Credentials, Backup, Wiederherstellung und ggf. Migration?
11. **Feedback und Deduplizierung:** Ist Nutzerfeedback erforderlich und wie beeinflusst es Bewertungen? Wann und wie sollen mehrere Artikel als eine Geschichte erscheinen?
12. **Verifikation:** Welche repräsentativen Inhalte und welche Qualitäts-/Fehlerfälle belegen brauchbare Auswahl, korrekte Sortierung, Schutz vor Fehlbedienung und Integration?

## Referenzen

- [IndyDevDan: Pi Durable News Agent](https://github.com/disler/pi-durable-news-agent) – Produkt- und HFS-Inspiration, kein festgelegter Unterbau.
- [FreshRSS Extension-Dokumentation](https://freshrss.github.io/FreshRSS/en/developers/03_Backend/05_Extensions.html) – untersuchte Alternative zur separaten UI.
- [Pi AI SDK](https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md) und [Pi SDK](https://pi.dev/docs/latest/sdk.md) – Modell- und Agentenintegration.
- [Pi Security](https://pi.dev/docs/latest/security.md) – Grenzen bei Agenten, Tools und fremden Inhalten.
- [Open-AIRSS](https://github.com/MarioGervais/open-airss) – früher untersuchtes alternatives Frontend; **als Basis ausdrücklich ausgeschlossen**.
