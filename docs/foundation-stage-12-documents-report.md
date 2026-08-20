# Foundation Stage 12 — Documents Report

## A. Stage 11 merge verification

- PR #8 miał finalny HEAD `49eeb7a39e463eb8a3bb88bd3fbd9b9a609f038d`, był otwarty, mergeable/clean i miał zielone: Foundation PostgreSQL, fresh migration/seed/startup, exact legacy rehearsal, Typecheck, Unit, Build, Browser oraz Production Dependency Audit.
- PR #8 został oznaczony Ready i scalony standardowym merge commitem `a4d81356064aca0cdf02516d332911e6342b4920`.
- `49eeb7a…` jest przodkiem `origin/main`; Stage 12 rozpoczęto na `agent/foundation-stage-12-documents` z `a4d8135…` i czystego worktree.

## B. Current Document contract

| Endpoint / command | Permission i scope | Authority przed Stage 12 | Lifecycle | Decyzja Stage 12 |
| --- | --- | --- | --- | --- |
| `GET /documents`, `GET /documents/:id` | `document:read-own` albo `document:read-all`; own przez linked MemberProfile | memory arrays, bez Prisma | read current catalog / own obligations | server paging, totals i scope z PostgreSQL |
| `POST /documents` | `document:manage`, global | `documents.push` | create | PostgreSQL create, DB sequence, normalized unique code, audit `sessionId=null` |
| `PATCH /documents/:id` | `document:manage`, global | `Object.assign(document, …)` | update metadata | `expectedVersion`; lifecycle fields niedostępne w PATCH |
| `POST /documents/:id/archive` | `document:manage`, global | `document.active=false` | Active → Archived | blokada przy current effective Requirements; brak silent cascade |
| `POST /documents/:id/reactivate` | `document:manage`, global | `document.active=true` | Archived → Active | versioned command i global audit |

`Document` pozostaje globalnym katalogiem kontrolowanych treści, a nie plikiem, incident recordem ani wersją treści. Production router nie wykonuje już aktywnych memory writes.

## C. Current Version contract

| Endpoint / command | Permission | Authority przed Stage 12 | Lifecycle | Decyzja Stage 12 |
| --- | --- | --- | --- | --- |
| `GET /documents/:id/versions`, `GET /document-versions/:id[/content]` | own/all read | memory filter | read history/content | bounded PostgreSQL history; content zwracany jako data |
| `POST /documents/:id/versions` | `document:version:manage` | `versions.push` | create Draft | DB sequence i unique `(documentId, normalizedVersionLabel)` |
| `PATCH /document-versions/:id` | `document:version:manage` | `Object.assign(version, …)` | edit Draft | wyłącznie Draft, `expectedVersion` |
| `POST /document-versions/:id/publish` | `document:publish` | mutable status assignment | Draft → Published; prior Published → Superseded | jedna serializable transaction, Document/Version locks, partial unique Published, actor/time/digest/audit |
| `POST /document-versions/:id/withdraw` | `document:publish` | mutable status assignment | Draft/Published → Withdrawn | operationId; Published wymaga reason; trwały actor/time/reason |

Published, Superseded i Withdrawn content jest immutable również na poziomie triggera DB. Supersede i withdraw nie kasują historycznych Requirements ani Acknowledgements.

## D. Current Requirement contract

| Endpoint / command | Permission i scope | Authority przed Stage 12 | Lifecycle | Decyzja Stage 12 |
| --- | --- | --- | --- | --- |
| `GET /document-requirements[/:id]` | read-all lub requirement-manage | memory filter, bounded/fuzzy resolution | read | PostgreSQL paging/filter/search/effective projection |
| `POST /document-requirements` | `document:requirement:manage`; Group dodatkowo actual incident assignment | `requirements.push` | create active | tylko Published Version; exact one-target DB CHECK; active exact duplicate blocked |
| `PATCH /document-requirements/:id` | jak wyżej | `Object.assign(requirement, …)` | update active | partial update zachowuje target, `expectedVersion`, target row locks |
| `POST /document-requirements/:id/end` | jak wyżej | `requirement.active=false` | Active → Ended | append-history, effectiveTo/endedAt/endedBy, operationId, bez delete |

Role i Member Requirements są globalne. Group Requirement przechowuje realne `OperationalGroup.id`, autoryzuje jego `incidentId` i audytuje ten incident. Stored `active` i derived `effective` są rozróżnione.

## E. Current Acknowledgement contract

| Endpoint / command | Permission i scope | Authority przed Stage 12 | Lifecycle | Decyzja Stage 12 |
| --- | --- | --- | --- | --- |
| `POST /document-versions/:id/acknowledge` (own) | `document:acknowledge-own`; target backendowo z linked MemberProfile | `acknowledgements.push` | append fact | Published/active/available/current applicable required obligation; server timestamp |
| ten sam endpoint (on behalf) | `document:acknowledge-all`, explicit member, `onBehalf=true`, note | memory row z niepełnym rozdzieleniem aktora | append fact | actor i member zapisani osobno; reason obowiązkowy |
| `GET /document-acknowledgements` | own/all/ack-all scope | memory filter | read history | server paging/filter/date range; relational source Requirement snapshot |

Nie istnieje edit ani delete endpoint. DB trigger blokuje update/delete acknowledgement i jego requirement links, a unique `(documentVersionId, memberProfileId)` gwarantuje jeden trwały fakt.

## F. Domain boundaries

- `Document` = globalny katalog; `DocumentVersion` = konkretna treść; `DocumentRequirement` = reguła applicability; `DocumentAcknowledgement` = historyczny fakt.
- `StoredFile`, upload, object storage, preview fetch, OCR i malware scanning nie zostały wprowadzone.
- MemberProfile, GroupMembership, OperationalGroup i IncidentAssignment zachowują własne lifecycle i source of truth.
- Compliance jest projection, nie pole kopiowane do MemberProfile.

## G. Scope model

Document, Version, Role Requirement, Member Requirement i Acknowledgement są globalne. Group Requirement wymaga rzeczywistego Group → Incident oraz aktywnego IncidentAssignment (System Admin zachowuje istniejący global override). GroupMembership ani GroupRoleAssignment nie nadają incident access. Własny globalny dokument nie wymaga aktywnego incidentu.

## H. Clock

Production używa `new Date()` przez Foundation clock adapter; testy wstrzykują deterministyczny `clock.now()`. Ten sam evaluation time steruje effectiveFrom/effectiveTo, overdue, review metadata, publish/withdraw i acknowledgement timing. Usunięto production zależność od demo `referenceNow`.

## I. Document lifecycle

Create/update/archive/reactivate są trwałe i versioned. Generic PATCH nie zmienia `active`. Archive nie wykonuje cascade: jeśli istnieje current effective Requirement, zwraca kontrolowany 409; operator musi najpierw zakończyć Requirement lub wycofać jego Published Version.

## J. Version FSM

```text
Draft -> Published | Withdrawn
Published -> Superseded | Withdrawn
Superseded -> terminal
Withdrawn -> terminal
```

Content i version metadata można edytować wyłącznie w Draft. Korekta opublikowanej treści wymaga nowej Version.

## K. Publish atomicity

Publish blokuje Document i target Version, waliduje expectedVersion, aktywny Document, Draft, content i oczekiwaną current Published Version. W tej samej serializable transaction superseduje poprzednią wersję, publikuje nową, zapisuje actor/time/digest, operation result i AuditLog. Partial unique index gwarantuje najwyżej jedną Published Version nawet poza service. Draft A vs Draft B daje dokładnie jednego logicznego zwycięzcę; loser otrzymuje 409.

## L. Supersede / Withdraw semantics

Requirements nie są automatycznie klonowane ani przenoszone. Requirement przypięty do Superseded/Withdrawn Version pozostaje historią, lecz przestaje być currently effective. Withdraw Published wymaga reason i zachowuje `withdrawnAt`, `withdrawnById`, `withdrawReason`. UI przed publish pokazuje counts current version i ostrzega, że Requirements nie przechodzą automatycznie.

## M. Content model

Internal text jest plain text, ma limit i po publish dostaje SHA-256; frontend nigdy nie renderuje go jako raw HTML. External link jest walidowany przy publish jako HTTPS-only, nie jest pobierany po stronie serwera i otwiera się z `target="_blank" rel="noopener noreferrer"`. Content availability jest derived z niepustego body albo dozwolonego URL.

## N. External content limitation

Acknowledgement external version dowodzi Version ID, code/title/label, URL snapshot, statement, member/actor/time i source Requirements. Nie dowodzi historycznych bytes pod zmiennym URL. `contentDigestSnapshot` jest tylko dla Internal text. Dokładny dowód external bytes wymaga przyszłego controlled storage slice; Stage 12 celowo go nie udaje.

## O. Requirement model

DB przechowuje dokładnie jeden target Role/Group/MemberProfile, active/effective window, due, acknowledgementRequired, end provenance, optimistic version i legacy provenance. Requirements powstają wyłącznie dla Published Version. Partial unique indexes blokują exact active duplicate, lecz po end pozwalają na nowy historyczny Requirement i pozwalają, aby jedna osoba była objęta różnymi Role/Group/Member regułami.

## P. acknowledgementRequired decision

`true` oznacza obowiązek ACK i wpływa na outstanding/overdue/compliance. `false` oznacza targeted awareness: treść jest widoczna, ale brak ACK nie tworzy overdue ani non-compliance i UI nie oferuje ACK. Boolean ma aktywną semantykę w API, totals, personal obligations i Readiness.

## Q. Role resolution

Jawny katalog: ZPP/TEC Member, ZPP/TEC Group Leader, ZPP/TEC Coordinator, Family Assistance, Welfare Support i Rostering. Mapping używa exact pool, active durable membership/Leader, linked UserRole albo exact assignedFunction. Brak `includes`, fuzzy fallback i page cap. Nieznany target daje kontrolowany 409/anomaly.

## R. Group resolution

Applicability pochodzi wyłącznie z aktywnego durable `GroupMembership`. Create/update blokuje Group row, odrzuca Archived i wymaga actual incident scope. Acknowledgement ponownie rozwiązuje membership po row lock, dzięki czemu removal-vs-ACK ma spójną kolejność. Późniejszy archive/removal nie kasuje historycznego Requirement ani ACK snapshotu.

## S. Member resolution

Member Requirement wymaga istniejącego, niearchiwalnego MemberProfile. Own ACK backendowo rozwiązuje linked profile; klient nie wybiera własnego member ID. Member archive jest serializowany z create Requirement i ACK; historyczne fakty pozostają zachowane.

## T. Acknowledgement semantics

ACK jest append-only server event dla jednej Published Version i jednego MemberProfile. Wymaga dostępnej treści i co najmniej jednego current effective Requirement z `acknowledgementRequired=true`. Unique constraint oraz deterministic duplicate result zapobiegają podwójnym rows przy simultaneous requests.

## U. On-behalf acknowledgement

Privileged actor podaje jawny Member, `onBehalf=true` i reason. Record przechowuje osobno `memberProfileId` oraz `acknowledgedById`; UI managera pokazuje self/on behalf, aktora i źródła. Own-vs-on-behalf race tworzy jeden durable ACK, bez udawania self action.

## V. Acknowledgement evidence / snapshot

ACK zapisuje code/title/version label/content mode, external URL snapshot albo Internal SHA-256, statement version, actor/member/time i relacyjne `DocumentAcknowledgementRequirement` links. Source links pozostają po end/withdraw. Legacy ACK nie ma sfabrykowanego digest/note/evidence: `legacyImported=true`, pola unavailable są null, a ograniczenie jest jawne w metadata i UI.

## W. Effective dates

Applicability: `effectiveFrom <= evaluationAt` oraz `effectiveTo > evaluationAt OR NULL`, dodatkowo active Document, Published Version, active Requirement i target applicability. Future Requirements są niewidoczne jako current; dokładnie na `effectiveTo` wygasają. Overdue zaczyna się dopiero, gdy `dueAt < evaluationAt`.

## X. Compliance

PostgreSQL projection zwraca `Not applicable`, `Attention`, `Non-compliant` lub `Compliant`. Uwzględnia current requirements, ACK-required policy, acknowledgement, due, content availability, Document/Version lifecycle i clock. Overdue jest derived; status nie jest zapisywany do MemberProfile. KPI liczą pełny scope po stronie serwera, nie pierwszą stronę.

## Y. Audit

Global Document/Version/Role/Member/ACK events zapisują `sessionId=null`. Group Requirement używa realnego Group incident. ACK może mieć wiele źródeł, dlatego audit nie wybiera arbitralnego incidentu; metadata zawiera `sourceRequirementIds` i `sourceGroupIds`. Audit powstaje w tej samej transaction co command.

## Z. Idempotency

`DocumentOperation` ma globalnie unique UUID, command fingerprint, target relation i stabilny JSON result. Publish, withdraw, end Requirement i acknowledge są retry-safe. Ten sam operationId + ten sam logical request zwraca committed result; reuse dla innego commandu/targetu/payloadu zwraca 409.

## AA. Concurrency

Serializable transactions, bounded serialization retry, ordered row locks i DB constraints pokrywają: code create, version-label create, Draft A/B publish, publish/edit, publish/withdraw, withdraw/ACK, archive/new Requirement, archive/ACK, Requirement update/end, end/ACK, duplicate/simultaneous own ACK, own/on-behalf ACK, Group membership removal/ACK, Group archive/new Requirement, Member archive/new Requirement i Member archive/ACK. Testy potwierdzają jeden Published, jeden ACK i spójną historyczną kolejność.

## AB. Readiness integration

Readiness nie zostało zmigrowane jako osobny persisted model. Jego Documents dimension wywołuje Foundation Document service/repository i liczy compliance z PostgreSQL. Nie ma compatibility write-back do memory. Po Stage 12 Member/Groups, Roster/Availability, Training i Documents są authoritative PostgreSQL inputs.

## AC. Notifications boundary

Publish callback jest best-effort i uruchamia się wyłącznie po committed, nie-idempotent publish. Wyjątek notification nie cofa Document transaction. W PostgreSQL mode wyłączono legacy Documents reconciliation z memory arrays, aby notification consumer nie otrzymywał fałszywego drugiego źródła. Durable Notifications/outbox oraz requirement notification delivery pozostają poza Stage 12.

## AD. API

Documents, Versions, Requirements, Acknowledgements i personal obligations mają bounded limit/offset, filtry i deterministic sort. Documents zwraca pełne scoped totals: documents, published, requirements, outstanding, overdue, acknowledged. Writes używają expectedVersion i operationId zgodnie z command risk. Błędy unique, stale, invalid transition/scope i concurrency są kontrolowanymi 4xx, bez P2002 leak.

## AE. Frontend

DocumentsPage używa server pages/totals i bounded Member/Group search zamiast katalogu 200. Obsługuje current/history provenance, inert Internal text, bezpieczny External link, publish consequence warning, stale 409 oraz explicit on-behalf drawer. Formularz targetu rozdziela opcjonalne pole wyszukiwania od wymaganego exact selecta. Dialog/focus/keyboard regression pozostaje zielony.

## AF. Backfill

Seed przenosi dokładnie 6 Documents, 6 Versions, 5 Requirements i 1 Acknowledgement: zachowuje IDs, codes, labels, content/link/status/dates i istniejących aktorów. Nie fabrykuje withdraw/archive/end provenance ani historical external digest. Legacy ACK jawnie oznacza brak historycznego evidence. Migracja pre-Stage-2 → Stage 12 tworzy 6 tabel, 4 sequences i zero synthetic DocumentOperation.

## AG. Scale

Test tworzy ponad 1000 MemberProfiles; exact TEC Role Requirement rozwiązuje ponad 1000 obligations, w tym członka poza pierwszymi 200. Queries i frontend pages pozostają bounded. Totals i compliance są liczone na pełnym PostgreSQL scope, bez ukrytego limitu 200.

## AH. Legacy removed + LOC

| Plik | Przed | Po | Uwagi |
| --- | ---: | ---: | --- |
| `apps/api/src/documents.ts` | 1312 | 1312 | memory/test adapter i legacy compatibility; nie jest production writerem |
| `apps/api/src/demo-router.ts` | 4182 | 4201 | Foundation router wiring; stare Documents routes są wyłączone przy PG service |
| `apps/api/src/routes/index.ts` | 1353 | 1361 | Prisma repository/clock wiring |
| `apps/web/src/pages/DocumentsPage.tsx` | 879 | 1017 | paging, totals, history, publish i acknowledgement UX |
| `apps/api/src/modules/documents/*` | 0 | 1370 | types, contract, service, router i Prisma adapter |

W production PostgreSQL mode nieosiągalne są legacy `documents.push`, `versions.push`, `requirements.push`, `acknowledgements.push`, status assignments i `Object.assign` command paths. Nie ma drugiego production Documents writer.

## AI. PostgreSQL tests

- Fresh PostgreSQL 16 migration: **15/15 PASS**.
- Exact seed: **6 Documents / 6 Versions / 5 Requirements / 1 Acknowledgement PASS**.
- Startup `/api/health`: **PASS**, `persistence=postgres`.
- Stage 1–12: **121/121 PASS, zero skipped**.
- Stage 12: **18/18 PASS**.
- Exact legacy rehearsal pre-Stage-2 → Stage 12: **PASS**; 6 tables, 4 sequences, zero synthetic operations.

## AJ. Browser tests

- Nowe Stage 12: **2/2 PASS** — paging/totals/search, version commands, warning publish, safe content, stale 409, lookup poza pierwszą stroną, on-behalf evidence i Requirement edit.
- Existing own Documents oraz shared keyboard/dialog/focus tests pozostają zielone.
- Pełny Browser gate: **70/70 PASS**.

## AK. CI

| Gate | Wynik |
| --- | --- |
| Fresh migration / exact seed / startup | PASS |
| Stage 1–12 PostgreSQL | PASS — 121/121, zero skipped |
| Exact legacy backfill rehearsal | PASS |
| Typecheck | PASS |
| Unit | PASS — 96/96 |
| Build | PASS |
| Browser | PASS — 70/70 |
| Production runtime Dependency Audit | PASS — zero findings (`dev` i optional Prisma CLI peer wyłączone) |
| Remote GitHub Actions | PASS — oba workflow events, wszystkie 3 jobs dla implementacyjnego SHA `d033436fe342f9f26f91de8c5e3124ac3dad8c1f` |

## AL. Remaining split-brain

| Kandydat | Rzeczywisty stan po Stage 12 | Ocena |
| --- | --- | --- |
| Readiness | computed orchestration; wszystkie cztery główne inputs są już PostgreSQL; brak własnych operational writes | nie jest teraz primary split-brain writerem |
| Notifications | production delivery/read-state i reconciliation nadal mają memory authority; centralny konsument wielu durable domains | najwyższy spójny write-owning kandydat |
| Briefings | Active Event/briefing state nadal memory, ale węższy consumer jednego incident context | po Notifications |
| Imports | staging/confirm lifecycle nadal memory; docelowe Passenger/Family records są durable | realny, lecz bardziej izolowany slice |
| Exports / Reports | głównie read/derived nad mieszanymi źródłami, mało własnej authority | po primary writers |
| Admin / Identity | User/Role są częściowo PostgreSQL, lecz lifecycle/policy ma pozostałości route-level/memory | krytyczny osobny security slice, większe zależności |

## AM. Risks — max 10

1. Memory test adapter może semantycznie odjechać od PostgreSQL contract; production nie korzysta z niego, ale test parity wymaga utrzymania.
2. Notifications są best-effort bez outbox, więc awaria po commicie może utracić publish komunikat.
3. Dynamic Role/Group applicability i scoped totals mogą wymagać query profiling przy znacznie większym katalogu.
4. External URL snapshot nie dowodzi historycznych bytes i nie może być prezentowany jako taki dowód.
5. Requirements nie przechodzą automatycznie na nową Published Version; manager musi świadomie utworzyć nowe reguły po publish.
6. Legacy ACK ma celowo niepełne evidence/provenance.
7. Append-only ACK nie ma correction/revocation workflow; ewentualna korekta wymaga przyszłego osobnego modelu.
8. Prisma CLI jest optional peer narzędziowym; production runtime audit pomija optional/dev graph, a pełny development graph nadal może raportować advisory nieobecne w runtime deployment.

## AN. Next decision

**Rekomendowany dokładnie jeden następny vertical slice: Notifications Persistence + Delivery Integrity.**

Notifications nadal posiadają production memory writes i są centralnym konsumentem Incident, Assignments, Rostering, Training i Documents, które mają już durable facts. Ich migracja usunie realny cross-domain split-brain oraz pozwoli modelować retry/outbox bez przebudowy źródeł. Readiness jest obecnie computed read service nad PostgreSQL inputs, Briefings i Imports są węższe, Reports są głównie derived, a Admin/Identity wymaga większego security closure. Następny slice nie został rozpoczęty.

## Final verdict

```text
READY FOR NEXT FOUNDATION SLICE
```

Production Documents writes trafiają wyłącznie do PostgreSQL, wszystkie lokalne i implementacyjne zdalne gates są zielone, a PR #9 pozostaje draft do przeglądu.
