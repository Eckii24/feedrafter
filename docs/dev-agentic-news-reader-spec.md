# Agentic News Reader – Produktspezifikation

[[dev-agentic-news-reader]] · [[dev]]

**Status:** Entwurf zur Prüfung · 2026-10-31. Keine Implementierungsfreigabe. Bestätigte Produktentscheidungen, konkrete Vorschläge und noch zu prüfende technische Annahmen sind als solche gekennzeichnet.

## Überblick

- **Ziel:** Matthias findet relevante Artikel und Videos schneller, priorisiert sie anhand nachvollziehbar konfigurierbarer Scores und entscheidet selbst, was er vertieft. Der Reader soll Aufmerksamkeit sparen, nicht Inhalte automatisch verwerfen.
- **Erster Wurf:** FreshRSS-Import, sichere Übernahme, Artikel- und Videoaufbereitung, konfigurierbare KI-Scores, Kategorien und Schlagwörter, persönliches Feedback, Web-Reader, Zusammenfassungen, E-Mail-Queue-API, Karakeep und Pi-Chat.
- **Randbedingungen:** eigenständige Anwendung nach Clean Architecture, als Docker-Image betreibbar; PostgreSQL separat. Private Erreichbarkeit und Zugriffsschutz außerhalb der App über ein vom Betreiber bereitgestelltes VPN. Pi ist die KI-Integrationsschicht; externer Modellanbieter ist abhängig von der Pi-Konfiguration.
- **Unverändert:** Der bestehende FreshRSS-Favoriten-Mail-/Audio-Workflow läuft zunächst parallel weiter. Die Anwendung versendet keine E-Mails selbst und ändert FreshRSS-Favoriten nicht.
- **Außerhalb des ersten Wurfs:** automatisches Ausblenden anhand niedriger Scores; Story-Clustering oder URL-Deduplizierung; native Mobile-App; allgemeines Plugin-System; Mailversand; eigenes Login-System; dauerhaftes Training von Modellen.
- **Offen / technische Prüfungen:** konkrete Pi-Anmeldebereitstellung im Container und Session-Persistenz, FreshRSS-Verhalten der laufenden Version, konkrete Modelle und Limits. Pi- und FreshRSS-Quellen sind geprüft, die reale Installation und Integration aber nicht live getestet; siehe Recherchebefunde.

## Begriffe und Zustandsgrenzen

- **FreshRSS-ID:** stabile Identität eines Eintrags in der konfigurierten FreshRSS-Quelle; sie wird unverändert gespeichert. Identität umfasst bei Bedarf die Quellinstanz/das Konto, nicht nur eine zufällig gleichlautende ID.
- **FreshRSS gelesen:** technisches Signal „in der neuen Anwendung dauerhaft übernommen“, nicht „Matthias hat den Artikel gelesen“.
- **Lesestatus:** eigener Status der neuen Anwendung: ungelesen oder gelesen. Unabhängig von FreshRSS und E-Mail-Status.
- **Hauptkategorie:** genau eine fachliche Zuordnung je Artikel oder der technische Fallback „Nicht zugeordnet“.
- **Schlagwort:** wiederverwendbarer Begriff; ein Artikel kann mehrere Schlagwörter haben. Nicht mit Hauptkategorien verwechseln.
- **Score:** konfigurierbare numerische Bewertung zwischen 0 und 100; mehrere Scores je Artikel sind unabhängig.
- **Vote:** persönliche Bewertung einer Artikel–Schlagwort- oder Artikel–Quelle-Zuordnung mit `+1`, `0` oder `−1`, nicht ein globaler Daumen für den Artikel.
- **Mailstatus:** nicht vorgesehen, vorgemerkt oder gesendet; sagt nichts über den Lesestatus aus.

## Anforderungen und Akzeptanzkriterien

### Datenübernahme und Hintergrundverarbeitung

- **AC1 – FreshRSS-Import:** Bei jedem Lauf alle zum Abfragezeitpunkt erreichbaren ungelesenen Einträge einschließlich weiterer Ergebnisseiten übernehmen; der erste Lauf ist nicht nach Alter oder Feed begrenzt.
  - FreshRSS-ID und Quellkontext, Titel, URL, Feed/Quelle, Autor und Veröffentlichungszeit soweit verfügbar sowie Importzeit dauerhaft speichern. Fehlende Metadaten werden als fehlend dargestellt, nicht erfunden.
  - Neue Einträge sind in der Anwendung ungelesen und nach Möglichkeit sofort mit ihrem Verarbeitungsstatus sichtbar.
  - Derselbe FreshRSS-Eintrag wird auch bei wiederholtem Import nur einmal angelegt; bereits vorhandene Einträge werden nicht als neu ungelesen zurückgesetzt und bestehende nutzereigene Zustände nicht überschrieben.
  - **Nicht verwechseln:** IDs vermeiden Doppelimport, nicht gleiche URLs verschiedener FreshRSS-Einträge oder ähnliche Meldungen.
  - Die paginierte FreshRSS-Abfrage ist kein garantierter Snapshot. Vor dem Ändern des Lesestatus die gesamte verfügbare Seitenfolge abrufen und dauerhaft speichern; anschließend gezielt bestätigen und bei späteren Läufen erneut vom Anfang nach verbleibenden Ungelesenen suchen. Änderungen durch andere Clients bleiben ein Integrationsrisiko.
  - Sichtbarkeit versteckter Feeds und die tatsächliche Abdeckung aller ungelesenen Einträge der laufenden API-Instanz müssen isoliert geprüft werden; keine Vollständigkeit behaupten, die die API nicht liefert.
- **AC2 – Übernahmebestätigung:** Nur Einträge, die in der eigenen DB dauerhaft vorhanden sind, einzeln bzw. anhand ihrer konkreten IDs in FreshRSS als gelesen markieren; niemals pauschal den gesamten Feed leeren.
  - Scheitert das Speichern, wird die ID nicht bestätigt. Scheitert das Markieren nach erfolgreichem Speichern, bleibt die Bestätigung ausstehend und wird später wiederholt.
  - Beim Wiederabruf einer bereits importierten, in FreshRSS noch ungelesenen ID keine zweite Kopie erzeugen, sondern die Bestätigung erneut versuchen.
  - Ausstehende Bestätigungen unabhängig davon dauerhaft verfolgen, ob die ID später noch in einer Ungelesen-Abfrage auftaucht; nach mehrdeutigem Antwort-/Netzwerkfehler den tatsächlichen Zustand prüfen und bei Bedarf erneut bestätigen.
  - Ein fehlgeschlagenes Teilstück oder ein Absturz darf keine bereits gespeicherten persönlichen Zustände verlieren. Bestätigungs- und Pagination-Verhalten der eingesetzten FreshRSS-Version vor Liveeinsatz verifizieren.
- **AC3 – Ausführung:** Zeitplan standardmäßig alle vier Stunden, in Settings veränderbar und abschaltbar; manueller Start in der UI.
  - Keine zwei Läufe gleichzeitig; ein manueller Start bei laufender Pipeline zeigt den bestehenden Lauf statt einen weiteren zu erzeugen.
  - Die UI zeigt Fortschritt sowie ausstehende, erfolgreiche und fehlgeschlagene Verarbeitung.
  - Gespeicherter DB-Zustand und fertige Ergebnisse überleben einen Neustart. Offene Schritte dürfen erneut laufen; keine komplexe Durable-Execution-Lösung als Selbstzweck und keine Garantie exakt einmaliger externer KI-Aufrufe bei Absturz.

### Quellen, Inhalte und Aufbereitung

- **AC4 – Artikelinhalt:** Inhalt anhand der Original-URL beschaffen; Feed-Body nicht blind als gültigen Volltext übernehmen. Erst deterministische Extraktion, danach eine Qualitätseinschätzung durch einen Classifier.
  - Bei unzureichendem Ergebnis darf ein Pi-Agent automatisch nacharbeiten, sofern die Quelle dafür freigeschaltet ist; Quellenfreigaben konfigurierbar. YouTube ist standardmäßig freigeschaltet.
  - Paywall, Zugangssperre oder unvollständiger Inhalt werden nicht als erfolgreicher Volltext ausgegeben; Fehler bzw. Unsicherheit und manuelles Wiederholen sind sichtbar.
  - Vollständigkeitseinschätzung ist heuristisch, kein Beweis für Vollständigkeit.
- **AC5 – Video:** Vorhandene Transkripte/Untertitel bevorzugen; sonst Audio herunterladen und automatisch transkribieren. Transkript ist der inhaltliche Ausgangspunkt für Video-Scores und Zusammenfassung.
  - Videos ohne verfügbares Transkript und ohne erfolgreiche Transkription bleiben mit Fehler und Retry sichtbar; kein erfundener Inhalt.
  - Werkzeug und Transkriptionsmodell konfigurierbar bzw. als Implementierungsentscheidung; `yt-dlp` und Transkription sind Kandidaten, keine Garantie für Zugriff auf jedes Video.
- **AC6 – Verarbeitung einzelner Einträge:** Kategorie, Schlagwörter und Scores folgen auf die erforderliche Aufbereitung; Schlagwörter stehen vor Score-Aufrufen zur Verfügung.
  - Ausstehende, unvollständige oder fehlgeschlagene Einträge bleiben sichtbar. Eine Bewertung auf eingeschränkter Grundlage muss als solche erkennbar sein; nicht vorhandene Scores bleiben leer statt einen Ersatzwert zu erfinden.
  - Ein defekter Artikel blockiert nicht alle anderen Artikel des Laufs.

### Kategorien und Schlagwörter

- **AC7 – Hauptkategorien:** Settings erlauben Kategorien zu verwalten. Ein Classifier weist genau eine zu oder wählt „Nicht zugeordnet“; für diesen Fallback gelten globale Prompt-Defaults.
  - Benutzer kann die Kategorie am Artikel korrigieren. Eine Neubewertung geschieht nur ausdrücklich, nicht automatisch durch die Änderung.
  - Startkategorien: KI & Agenten; Softwarearchitektur & Engineering; Entwicklerwerkzeuge & Plattformen; Homelab, DevOps & Smart Home; Produktivität & Wissensmanagement; Haus & Wohnen; Gesundheit & Fitness; Hobbys & Allgemeinwissen.
- **AC8 – Schlagwortvergabe:** KI vergibt bis zu zehn passende Schlagwörter pro Artikel; Ziel fünf bis zehn, weniger wenn sachlich geboten.
  - Vorhandene Begriffe bevorzugen; neue bei tatsächlichem Bedarf erstellen. Benutzer kann Schlagwörter am Artikel ergänzen/entfernen und den Katalog verwalten.
  - **Technischer Ausgangsvorschlag:** Reguläres Pi-LLM für Erzeugung/Normalisierung neuer freier Begriffe; Pi-Classifier für Auswahl/Scoring aus vorgegebenen Antworten. Die gesichtete Pi-AI-Schnittstelle liefert `choice`, `score` oder `bool`, keine frei erzeugte Schlagwortliste. Praktische Modell-/Providerkompatibilität und Kosten vor Festlegung verifizieren.
  - Entfernen einer Zuordnung löscht bestehendes Feedback nicht stillschweigend; frühere bewertete Ziele bleiben am Artikel auffindbar und änderbar.
- **AC9 – Schlagwörter zusammenführen:** In Settings mehrere Begriffe auswählen und zu einem Zielbegriff kombinieren. Artikelzuordnungen werden auf das Ziel umgestellt, alte Begriffe nach erfolgreichem Merge hart gelöscht, manuelle Offsets addiert und Gesamtgewichte neu berechnet.
  - Pro Artikel bleibt ein Vote auf das Ziel: Vorzeichen der Summe aller beteiligten Votes; positive Summe → `+1`, negative → `−1`, null → `0`. Alle gleichzeitig aggregieren, damit die Reihenfolge keinen Einfluss hat.
  - Beispiele: `+1/+1 → +1`, `+1/−1 → 0`, `+1/0 → +1`. Zeitstempel des Ergebnisses: neuestes beteiligtes Vote-Datum, nicht der Merge-Zeitpunkt.
  - Bei Fehler darf kein halb umgestellter, inkonsistenter Merge sichtbar werden.

### Scores und persönliche Präferenzen

- **AC10 – Score-Konfiguration:** Settings bieten eine Liste konfigurierbarer Scores mit Name, Beschreibung, Prompt, Status, optionalen Prompt-Overrides je Hauptkategorie und Kontextauswahl. Einheitliche Skala 0–100.
  - Wählbarer Kontext umfasst mindestens Titel, Inhalt, Kategorie, Schlagwortgewichte und Quellengewicht. Schlagwort-/Quellengewichte je Score unabhängig an-/abschaltbar.
  - Nur für den aktuellen Artikel relevante Schlagwörter mit Gewicht bzw. dessen Quelle mit Gewicht werden mitgegeben, nicht ungefragt die vollständige globale Tabelle. Keine fest eingebaute zusätzliche Gewichtsmultiplikation nach dem Classifier.
  - Start-Scores: Hype, Facts, Signal und persönliche Relevanz. Standardmäßig berücksichtigt nur persönliche Relevanz die Präferenzgewichte. Facts ist keine unabhängige Faktenprüfung; Signal und persönliche Relevanz sind getrennte Dimensionen.
- **AC11 – Änderungen und Neubewertung:** Neue/angepasste Prompts und Modelle gelten für spätere Aufrufe; keine automatische Neubewertung und keine Speicherung der jeweils verantwortlichen Prompt-/Modellkonfigurationsversion pro Score.
  - Neue Scores werden für neue Bewertungen angewandt; vorhandene Artikel zeigen dafür unbewertet, bis manuell neu bewertet.
  - Eine manuelle Neubewertung berechnet alle aktiven Scores des Artikels.
  - Scores werden nur per Soft Delete entfernt: bisherige Werte bleiben erhalten, entfernte Scores erscheinen nicht mehr als aktive Anzeige-/Sortieroption. Kein Hard Delete für Scores.
- **AC12 – Zielgerichtetes Feedback:** 👍/👎 öffnet eine Auswahl der dem Artikel zugeordneten Schlagwörter und seiner Quelle; mehrere Ziele können gewählt werden. Der Daumen bestimmt die Richtung.
  - Ein Vote je Artikel/Ziel; ändern, entfernen bzw. neutralisieren möglich. Jede explizite Voting-Aktion aktualisiert das Vote-Datum, auch bei erneuter Wahl desselben Werts. Kein eigener Artikel-Daumen und keine unmittelbare automatische Neubewertung.
  - Settings zeigen pro Schlagwort und Quelle positive/negative Votes, aktuelles Gewicht und manuelle Korrektur; Suche und Sortierung unterstützen die Verwaltung.
- **AC13 – Zeitgewichtung:** Gesamtgewicht eines Ziels = manuelle Korrektur plus Summe zeitgewichteter Votes. Neuere Votes zählen stärker; der manuelle Offset altert nicht.
  - Halbwertszeit konfigurierbar, Default **drei Monate**. Nach einer Halbwertszeit zählt ein unveränderter Vote halb so stark; neutral trägt null bei.
  - Konkrete Definition der Einheit „Monat“, genaue Kurve zwischen Halbwertspunkten und Darstellung großer Gewichte sind als Implementierungsvorschlag zu präzisieren. Rohwerte nicht stillschweigend kappen oder Rankings verfälschen.

### Oberfläche und Aktionen

- **AC14 – Reader:** Responsive Weboberfläche für Desktop und Smartphone, klassische Liste, standardmäßig ungelesene Einträge nach Signal absteigend. Wird der Standard-Sortierscore entfernt, automatisch nach Datum sortieren.
  - Sortierung nach aktiven Scores und Datum; Titel-Sortierung als bestätigte Option nach Bedarf. Sortierung gilt über die gesamte gefilterte Ergebnismenge, nicht nur über eine geladene Seite.
  - Filter nach Kategorie, Quelle, gelesen/ungelesen, Artikel/Video und Verarbeitungsstatus; Textsuche nach Titel. Niedrig bewertete Artikel nicht automatisch ausblenden.
  - Gelesen markieren entfernt den Artikel aus der Standardansicht; gelesene Artikel bleiben auffindbar und können wieder ungelesen gesetzt werden. Keine automatische Löschung im ersten Wurf.
- **AC15 – Zusammenfassung:** Artikelbezogener Button startet ein reguläres Pi-LLM mit konfigurierbarem Prompt über den vorhandenen Artikelinhalt bzw. das Transkript.
  - Ergebnis wird gespeichert und wieder angezeigt. Explizites erneutes Zusammenfassen ersetzt die bisherige Zusammenfassung erst nach erfolgreicher neuer Verarbeitung; Fehler sind sichtbar.
- **AC16 – Karakeep:** Button speichert bewusst die Original-URL als Bookmark; Karakeep-URL und Token konfigurierbar. Kein eigener Tag/Status und kein automatisches Einspeisen aller Artikel.
  - Erfolg/Fehler anzeigen; bei bereits gespeicherter URL keine unbeabsichtigte Doppelanlage, soweit die Karakeep-API dies zuverlässig feststellen kann. Tatsächliche API-Semantik ist noch zu verifizieren.
- **AC17 – E-Mail-Queue:** UI erlaubt je Artikel nicht vorgesehen → vorgemerkt; vorgemerkte Artikel können wieder abgewählt werden. Die API liefert vorgemerkte, noch nicht als gesendet bestätigte Artikel einschließlich stabiler Artikel-ID und der für die Verarbeitung erforderlichen Metadaten/Inhalte.
  - Eine separate API markiert nur vom externen Verbraucher explizit übermittelte Artikel-IDs als gesendet. Wiederholte Bestätigung derselben IDs ist idempotent. Lesestatus und Karakeep bleiben davon unberührt.
  - Versand, Versandbestätigung beim Mailprovider und Vermeidung eines Doppelversands bei erfolgreichem Versand aber fehlgeschlagener API-Bestätigung liegen ausdrücklich beim konsumierenden System. Die Reader-API beansprucht kein Exactly-once-Versprechen.
  - Konkrete HTTP-Routen und Response-Details werden im API-Vertrag der Implementierungsplanung festgelegt, ohne die obige Semantik zu ändern.
- **AC18 – Pi-Chat:** Pi verwaltet die Chat-Sessions über sein eigenes Session-Management; bestehende Sessions lassen sich laden und fortsetzen, neue starten.
  - Copy-to-Chat fügt eine oder mehrere interne Artikelreferenzen ins Eingabefeld ein und sendet nicht automatisch. Der Chat erhält lesenden Zugriff auf die gespeicherten Inhalte referenzierter Artikel.
  - Lesende Websuche und Seitenabruf stehen zur Verfügung; kein allgemeines Bash, kein direkter Zugriff auf Secrets und keine Schreibaktionen auf Artikelzustände. Aufrufanzahl und Laufzeit sind begrenzt.
  - Pi-Session-Daten müssen Container-Neustarts überleben und in die Backup-/Restore-Grenze fallen; die Speicherform ist gesondert zu verifizieren und nicht automatisch PostgreSQL.

### KI, Betrieb und Sicherheitsgrenzen

- **AC19 – Pi und Modelle:** Integration über Pi SDK oder Pi Durable bzw. passende Pi-Modell-Schnittstellen; Auswahl mit geringstem erforderlichem Overhead. Für jede Aufgabe – Kategorie, Qualitätsprüfung, Schlagwörter, Scores, Extraktionsagent, Zusammenfassung, Chat, Transkription – ein Modell bzw. passender konfigurierbarer Dienst. Ein Modell kann mehrere Aufgaben erfüllen.
  - Optionales explizites Pi-Fallback-Modell; ohne Konfiguration kein stillschweigender Fallback. Fehler und nicht unterstützte Aufgabentypen sichtbar melden. Verwendete Modellanbieter/Datenweitergabe erkennbar machen.
  - Technische Authentifizierung von Pi im Container gemäß verifizierter SDK-/Provider-Unterstützung; keine im Browser oder Repository offengelegten Secrets. Ob ein Live-Login in der App sinnvoll und unterstützt ist, steht noch nicht fest.
- **AC20 – Limits:** Automatische LLM-Verarbeitung, interaktive LLM-Aufrufe und Transkription getrennt begrenzbar; Classifier separat und großzügig konfigurierbar.
  - Laufende und ausstehende Arbeit bei Erreichen eines Limits sichtbar pausieren statt Artikel zu verlieren. Wo Kosten nicht verlässlich verfügbar sind, ergänzende konfigurierbare Aufruf-/Nutzungslimits anwenden. Konkrete Default-Zahlen sind Vorschläge, keine bestätigten Werte.
- **AC21 – Architektur und Betrieb:** Anwendung nach Clean Architecture schneiden: Geschäftsregeln unabhängig von UI, Persistenz und konkreten externen Adaptern. Docker-Image plus separate PostgreSQL-Datenbank; dauerhafte Daten und Pi-Sessions müssen Neustart und Wiederherstellung überstehen.
  - Zugangsschutz ist explizit eine Infrastrukturvoraussetzung: nur über das private VPN; kein eingebautes Anwendungskonto erforderlich. Ein ungeschützt öffentlich exponierter Dienst ist außerhalb des vorgesehenen Betriebsmodells. Betreiber verantwortet VPN, Infrastruktur und Backups.
  - DB-Zustand und Pi-Session-Speicher im Backup erfassen; reine Sicherung eines Container-Images enthält keine persistenten Daten. Konsistente PostgreSQL-Sicherung und Wiederherstellung müssen praktisch nachgewiesen werden.
  - Browser, API und Agenten verarbeiten fremde Inhalte als untrusted data; keine Shell oder Secret-Weitergabe an Agenten, eingeschränkte Netzwerkzugriffe und sichere Darstellung. Privat/VPN bedeutet nicht, dass externe Modellanbieter keine Artikeltexte sehen.

## Vorschläge für Startprompts und Modellrollen

Die folgenden Texte sind bewusst **erste Vorschläge**, keine behauptet erprobten Qualitätswerte. Alle Prompts sind in Settings änderbar; Kategorie-Overrides sind möglich.

- **Hype – Classifier:** „Bewerte 0–100, wie stark der Inhalt durch übertriebene, werbliche oder unbelegte Behauptungen statt durch substanzielle Informationen geprägt ist. 0 = kein Hype; 100 = nahezu reine Übertreibung. Ignoriere, ob Matthias das Thema persönlich mag.“
- **Facts – Classifier:** „Bewerte 0–100, wie überprüfbar die Aussagen anhand der vorliegenden Informationen sind. Primärquellen, konkrete Daten, Versionen und belegte Details erhöhen den Wert; unbelegte Behauptungen senken ihn. Behaupte keine unabhängige Faktenprüfung.“
- **Signal – Classifier:** „Bewerte 0–100, wie konkret und zeitnah die Information praktisch anwendbar ist. Hintergrundinformation kann wertvoll sein, aber weniger unmittelbar handlungsfähig. Bewerte unabhängig von der persönlichen Beliebtheit der Quelle.“
- **Persönliche Relevanz – Classifier:** „Bewerte 0–100, wie wahrscheinlich dieser Inhalt Matthias bei seinen Interessen und Aufgaben nützt. Berücksichtige die gewählte Hauptkategorie und die mitgelieferten Präferenzgewichte für Quelle und Schlagwörter als Hinweise, nicht als Fakten über den Inhalt. Niedrige oder neutrale Gewichte allein bedeuten nicht, dass der Inhalt unwichtig ist.“
- **Qualitätsprüfung – Classifier:** „Ist der extrahierte Text ein brauchbarer, in sich zusammenhängender Hauptinhalt statt Navigation, Paywall-Hinweis oder Fehlerseite? Bei fehlender Evidenz Unsicherheit melden; keine Vollständigkeit behaupten.“ Ausgabeformat muss zum tatsächlich unterstützten Classifier passen.
- **Schlagwörter – reguläres LLM, Vorschlag:** „Vergib bis zu zehn präzise Themenbegriffe, möglichst fünf bis zehn, sofern inhaltlich sinnvoll. Nutze vorhandene Begriffe, wenn passend; erfinde nur bei Bedarf neue. Gib strukturierte, validierbare Ergebnisse zurück und keine Begriffe, die der Inhalt nicht stützt.“
- **Zusammenfassung – reguläres LLM, Vorschlag:** „Fasse den vorliegenden Inhalt auf Deutsch übersichtlich und quellentreu zusammen: Kernaussage, wichtigste konkrete Punkte, gegebenenfalls praktische Konsequenz und wesentliche Einschränkungen. Fehlende oder unvollständige Grundlage benennen; keine Details erfinden.“
- **Modelle und Budgets:** Konkrete Provider, Modell-IDs, Kosten und Tagesbudgets werden nicht geraten. Günstige kompatible Classifier für strukturierte Entscheidungen, reguläres LLM für freie Schlagworterzeugung/Zusammenfassung/Chat; Transkription über kompatiblen Dienst. Default-Werte vor dem ersten größeren Lauf anhand verfügbarer Modelle und repräsentativer Inhalte festlegen.
- **Kostentransparenz, Vorschlag:** Provider-gemeldete Kosten, aus konfigurierten Preisen geschätzte Kosten und unbekannte Kosten unterscheidbar anzeigen; unbekannt nicht als null ausgeben. Bei nicht verlässlichen Kosten ein Aufruf-/Nutzungslimit als zusätzliche Schranke nutzen.

## Verifizierte technische Recherche – kein Live-Test

- **Pi-Classifier:** Die [Pi-AI-Dokumentation auf geprüftem Quellstand](https://github.com/earendil-works/pi/blob/81f3cd412758ebdd92324c7d63b669a189408d0a/packages/ai/README.md#classification) definiert strukturierte Eingaben und Antworten als Auswahl, Score oder Bool. Das bestätigt Matthias’ Einwand für freie neue Schlagwörter: Dafür ist in dieser API ein generatives Modell bzw. ein anderer Mechanismus nötig. Die konkrete Laufzeit und ein konfigurierter Provider wurden nicht getestet.
- **Pi-Authentifizierung:** Pi dokumentiert [API-Keys über Umgebungsvariablen und OAuth auf Headless-Systemen](https://github.com/earendil-works/pi/blob/81f3cd412758ebdd92324c7d63b669a189408d0a/packages/coding-agent/docs/providers.md); der [ModelRuntime-Code](https://github.com/earendil-works/pi/blob/81f3cd412758ebdd92324c7d63b669a189408d0a/packages/coding-agent/src/core/model-runtime.ts) bietet programmgesteuertes Login mit Interaktions-Callbacks. Ein Login zur Laufzeit ist damit grundsätzlich möglich, braucht für OAuth aber einen geeigneten sicheren Interaktionskanal und providerabhängige Unterstützung. Ein eingebauter Web-Login ist damit weder beschlossen noch fertig vorhanden. Empfehlung für den ersten Wurf: externe sichere Credential-Bereitstellung; UI-Login nur bei Bedarf ergänzen.
- **Pi-Sessions:** Das [Coding-Agent-SDK](https://github.com/earendil-works/pi/blob/81f3cd412758ebdd92324c7d63b669a189408d0a/packages/coding-agent/docs/sdk.md#session-storage) speichert Sessions standardmäßig persistent und verwaltet sie selbst; dateibasierter Session-Speicher muss im Container ein persistentes, gesichertes Volume erhalten. PostgreSQL für App-Daten bedeutet nicht automatisch, dass Pi-Sessions dort liegen. Restore praktisch testen.
- **Pi-Fallback:** Modellwiederherstellung beim Start und automatischer Fallback nach einem fehlgeschlagenen Aufruf sind verschiedene Dinge. Die [Pi-Routing-Dokumentation](https://github.com/earendil-works/pi/blob/81f3cd412758ebdd92324c7d63b669a189408d0a/packages/coding-agent/docs/virtual-models.md) beschreibt einen Routing-Mechanismus; AC19 verlangt weiterhin ausdrücklich konfiguriertes Fallback-Verhalten, nicht die Annahme eines automatischen Defaults.
- **FreshRSS:** Der geprüfte [API-Quellstand](https://github.com/FreshRSS/FreshRSS/blob/fa040c2ebbf01dd1d9ef854c855ace3a342d26f9/p/api/greader.php) implementiert paginierte Stream-Abfragen und `edit-tag` für Read-Markierungen. Quellstand ist nicht die bestätigte Deployment-Version. Beim Durchlaufen einer nach ungelesen gefilterten Seitenfolge können vorzeitige Statusänderungen die Fortsetzung beeinflussen; AC1/AC2 vermeiden deshalb eigene Read-Mutations während des vollständigen Abrufs und verlangen erneute Scans. Fremde gleichzeitige Änderungen bleiben gesondert zu prüfen.
- **Inspiration:** Die [HFS-Definition](https://github.com/disler/pi-durable-news-agent/blob/273b79bb8d3d8907cae9fbd6abd3da163ee2a343/apps/dna-server-api/prompt_engineering/jev/hfs/command.json) der Vorlage unterscheidet Hype, Prüfbarkeit und unmittelbar handlungsfähiges Signal; die vorgeschlagenen Prompts passen dieses Konzept an Matthias an und sind nicht als Qualitätsnachweis getestet.

## Erforderliche Evidenz vor Freigabe einer Implementierung

- **AC1–AC3:** isolierte FreshRSS- und DB-Prüfung inklusive mehrerer Seiten, Einträgen, die während des Laufs hinzukommen, wiederholtem Import, Fehler zwischen DB-Commit und Read-Markierung sowie Wiederanlauf. Keine pauschale Lesemarkierung.
- **AC4–AC6:** repräsentative Originalartikel, Paywall/Fehlerseite, vollständige und unvollständige Extraktion, Videos mit und ohne Untertitel, Transkriptionsfehler und unabhängige Weiterverarbeitung anderer Einträge.
- **AC7–AC13:** frei konfigurierbare Scores, Kategorie-Fallback, fehlende Scores, Vote-Änderung und -Alterung, manuelle Offsets, Merge-Kollisionen einschließlich mehr als zwei Begriffen und erneute Bewertung; Wirkung von Feedback anhand echter Beispiele prüfen, nicht nur Prompt-Weitergabe.
- **AC14–AC18:** globale Sortierung über mehrere Seiten, Desktop/Phone, gespeicherter Lesestatus/Summary, Karakeep-Fehler, Mail-API-Idempotenz und Pi-Session-Restore. Mail-Versand selbst ist nicht Bestandteil dieses Systems.
- **AC19–AC21:** Modell- und Provider-Konfiguration ohne Secret-Leak, begrenzte Tools und fehlender Fallback, Limit-Pausierung, isolierter Docker-/PostgreSQL-Neustart, konsistentes Backup und Wiederherstellung inklusive Pi-Sessions; keine behauptete Sicherheit nur aufgrund von Docker/VPN.

## Offene technische Prüfungen und Entscheidungen

- Pi SDK: konkrete Credential-Bereitstellung, persistentes Session-Volume und Restore im gewählten Container praktisch prüfen; Entscheidung, ob externe Provisionierung genügt oder später eine sichere interaktive OAuth-Oberfläche gebraucht wird.
- FreshRSS: tatsächliche laufende Version, API-Pagination und ID-/Read-Markierung je ID, Retry-Semantik und Verträglichkeit mit dem bestehenden Favoriten-Job read-only bzw. isoliert prüfen.
- Pi-Classifier: genutzte Pi-Version, konkrete Provider- und Modellverfügbarkeit sowie Fehler- und Kostenverhalten praktisch prüfen; freie Schlagworterzeugung über reguläres LLM als Startvorschlag.
- Drei Monate als Halbwertszeit: exakte Einheit und mathematische Kurve so festlegen, dass sie mit dem erklärten Verhalten übereinstimmt. Große Gewichte und manuelle Offsets sollen verständlich bleiben.
- Konkrete Provider/Modelle, Default-Budgets, Modellzugriff und mögliche zusätzliche Dienste für Transkription; technische Bereitstellung, Datenschutz und Lizenz-/Kostenfolgen prüfen.
- Karakeep-API: Duplicate-/Retry-Verhalten und zulässige Konfiguration testen; keine bestehenden Bookmarks verändern.

## Quellen

- [Projektkontext und Entscheidungen](dev-agentic-news-reader.md).
- [IndyDevDan: Pi Durable News Agent](https://github.com/disler/pi-durable-news-agent) und [HFS-Definition auf fixiertem Stand](https://github.com/disler/pi-durable-news-agent/blob/273b79bb8d3d8907cae9fbd6abd3da163ee2a343/apps/dna-server-api/prompt_engineering/jev/hfs/command.json): Inspiration für Bewertungen; keine Verpflichtung zu Gewichten, Filtern oder Architektur der Vorlage.
- [Pi AI SDK](https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md), [Pi SDK](https://pi.dev/docs/latest/sdk.md), [Pi Security](https://pi.dev/docs/latest/security.md): Integration, Auth und Sicherheitsgrenzen; Kompatibilität mit tatsächlich verwendeter Version prüfen.
