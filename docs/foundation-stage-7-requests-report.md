# Foundation Stage 7 — Requests Report

## A. Stage 6 merge verification

- PR #3 obejmował wyłącznie Foundation Stage 6 Release/Reunification. Przed merge był mergeable, bez konfliktów, z zielonym Foundation PostgreSQL Gate oraz Typecheck/Unit/Build/Browser. Jedynym czerwonym jobem pozostał zaakceptowany advisory React Router `GHSA-qwww-vcr4-c8h2`; nie pojawiły się nowe findings.
- Draft został zdjęty, a PR scalono standardowym merge commit: `27ad4785adfae7c3570326f1351148432eb0d5b9`.
- Commit Stage 6 `3f2642f153d4dc9890520f0daae663a7f22b28c0` jest przodkiem `origin/main`. Po fast-forward i potwierdzeniu clean worktree Stage 7 rozpoczęto z `origin/main` na `agent/foundation-stage-7-requests`.

## B. Current Requests contract

Stan zinwentaryzowany przed implementacją:

| Operation          | Endpoint/caller                            |                 Frontend |                      Legacy memory |                         Old Prisma | Stage 7 decision                                                            |
| ------------------ | ------------------------------------------ | -----------------------: | ---------------------------------: | ---------------------------------: | --------------------------------------------------------------------------- |
| List/queue         | `GET /requests`                            | `RecordsPage`, fetch-all |             `listRows("requests")` |                           raw list | `GET /requests/queue`, server paging/search/filter/sort                     |
| Get                | generic row z listy                        |    drawer z row snapshot |                     lookup tablicy | brak bezpiecznego context endpoint | `GET /requests/:id`, świeży permission-intersected context                  |
| Create             | `POST /requests`                           |           generic create |            `createRow("requests")` |     direct `welfareRequest.create` | idempotentny `POST /requests` przez RequestService                          |
| Edit               | `PATCH /requests/:id`                      |             generic edit |            `updateRow("requests")` |                      direct update | tylko facts/notes/dueAt + `expectedVersion`                                 |
| Status             | `POST /requests/:id/status`, generic PATCH |            status select |                     dowolny string |                direct status write | usunięte; wyłącznie controlled commands                                     |
| Urgent/priority    | priority w generic create/edit             |              zwykłe pole |                      dowolny write |                      dowolny write | jeden katalog `priority`; dedykowany versioned command                      |
| Assignment/owner   | `assign-to-me`, generic owner string       |    przycisk/generic edit |           `ownerAssignedTo` string |               direct string update | assign/reassign/unassign do aktywnego incident usera przez `ownerUserId` FK |
| Due date           | brak                                       |                     brak |                               brak |                               brak | `dueAt`, derived `overdue`, indeks i filtr serwerowy                        |
| Resolve/complete   | status `Closed` + closure note             |    generic status action |               direct status update |               direct status update | `POST /requests/:id/resolve`, human outcome/note/actor/time                 |
| Reopen             | brak kontrolowanego kontraktu              |                     brak |        możliwy przez generic write |        możliwy przez generic PATCH | dedykowany idempotentny command z reason/actor/time                         |
| Cancel             | status string                              |           generic status |                       direct write |                       direct write | osobny idempotentny command; nie oznacza resolution                         |
| Related Passenger  | nullable FK                                |               row/detail |                    raw object link |                        raw include | ten sam incident, DB trigger, minimalna projection wg `passenger:read`      |
| Related Family/NOK | nullable FK                                |               row/detail |                    raw object link |                        raw include | ten sam incident, DB trigger, minimalna projection wg `family:read`         |
| Related Enquiry    | nullable FK                                |               row/detail |                    raw object link |                        raw include | ten sam incident, DB trigger, minimalna projection wg `enquiry:read`        |
| Related Release    | brak                                       |                     brak |                               brak |                               brak | opcjonalny FK, same-incident defence, projection wg `release:read`          |
| Notes              | generic PATCH                              |             generic edit |                       direct write |                       direct write | korekta facts, bez przejścia workflow i bez timeline noise                  |
| Timeline           | create/close                               |                 Timeline |            osobny write po mutacji |            osobny write po mutacji | operacyjnie istotne zdarzenia w tej samej transakcji                        |
| Audit              | create/update/assign/status                |                    Audit |                       osobny write |                       osobny write | actor/incident/before-after/reason/version/request ID atomowo               |
| Dashboard          | dashboard/summary service                  |        KPI i urgent list |                 czyta `requests[]` |                       direct query | read-only PostgreSQL compatibility projection                               |
| Active Event       | active-event service                       |                  summary |                 czyta `requests[]` |             brak osobnego contract | read-only projection                                                        |
| Reports/export     | `requests-log`, session package            |                  Reports |               eksport `requests[]` |                       direct reads | read-only projection, bez write-back                                        |
| Notifications      | derived service                            |         notifications UI | brak Request mutation notification |              brak trwałego outboxu | bez redesignu i bez zależności poprawności Request od notification          |
| Delete             | generic route mógł sugerować CRUD          |          brak jawnego UX |              generic resource path |          brak bezpiecznej polityki | brak endpointu; pomyłki kończą się `CANCELLED`                              |
| Import             | legacy generic request CSV                 |                  Imports |                 memory/direct path |                      direct create | stary write zwraca `410`; importer domenowy pozostaje przyszłym zakresem    |
| Compatibility      | `GET /requests` i tablice konsumentów      |             stare moduły |                    canonical array |                   raw Request rows | jawnie deprecated/read-only projection z historycznymi etykietami statusów  |

## C. Field classification

| Klasa                      | Istniejące/nowe pola                                                                                                                    | Decyzja Stage 7                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. Request facts           | `category`, `details`, `requester`, `approvalStatus`, `notes`                                                                           | operator-maintained facts; nie są stanem innych domen                                                                           |
| B. Cross-domain references | `relatedEnquiryId`, `relatedFamilyRecordId`, `relatedPassengerRecordId`, `relatedReleaseActionId`, `caseId`                             | cztery realne FK z same-incident defence; `caseId` pozostaje legacy text, bez udawanego FK                                      |
| C. Operational planning    | `priority`, `ownerUserId`, `dueAt`                                                                                                      | kontrolowany priorytet i ownership, derived overdue; bez SLA engine/group ownership                                             |
| D. Controlled workflow     | `status`, `version`                                                                                                                     | zamknięty FSM i dedykowane commands; brak generic status PATCH                                                                  |
| E. Resolution              | `resolutionOutcome`, `resolutionNote`, `resolvedById/At`, `reopenedById/At/reason`, `cancelledById/At/reason`                           | human decision/provenance; reopen nie kasuje poprzedniej resolution                                                             |
| F. Technical               | UUID, `incidentId`, `operationalId`, version, actor IDs, timestamps, `RequestOperation.operationId/fingerprint/resultVersion/requestId` | trwała identity, concurrency, retry i audit correlation                                                                         |
| G. Legacy/unclear          | `ownerAssignedTo`, historyczne statusy, `closureNote`, `caseId`, brak transition history                                                | label zachowany jako `legacyOwnerLabel`; statusy mapowane uczciwie; brak historii zapisany w metadata, nic nie jest fabrykowane |

Nie istniało odrębne pole `urgent`; `Urgent` było poziomem `priority`, dlatego Stage 7 nie tworzy drugiej semantyki.

## D. Request domain semantics

Request jest incidentowym opisem potrzeby lub zobowiązania do obsłużenia. Nie jest źródłem prawdy Passenger, Family/NOK, Enquiry, Matching ani Release. Resolution oznacza wyłącznie ludzkie potwierdzenie wyniku Request i nigdy nie wykonuje komendy powiązanej domeny.

## E. Target architecture

Jedyny write/read contract modułu to `RequestService` + `RequestRepository`. Produkcja używa `PrismaRequestRepository`; `MemoryRequestRepository` jest wyłącznie test double. `IncidentAccessService` pozostaje wspólną warstwą scope. Nie dodano workflow engine ani sztucznej encji decyzji/status history.

## F. Data model

Istniejąca tabela `WelfareRequest` została zachowana fizycznie i zmapowana jako autorytatywny model Prisma `Request`, co ogranicza ryzyko migracji. Model zawiera UUID, `incidentId`, concurrency-safe `operationalId`, `version`, facts, owner FK, planning, lifecycle/resolution provenance, cztery FK kontekstowe i legacy metadata. `RequestOperation` jest technicznym ledgerem retry, nie drugim workflow. CHECK-i chronią version/status/priority i wymagane dane stanów terminalnych; nie ma hard delete API.

## G. Request types/categories

Zachowano dokładnie istniejący katalog: Transport, Accommodation, Interpreter, Medical, Psychological First Aid, Accessibility, Food / water, Documents, Communication, Other. Nie rozszerzono product scope.

## H. Status FSM

```text
OPEN --assign--> ASSIGNED
OPEN | ASSIGNED | WAITING --start--> IN_PROGRESS
OPEN | ASSIGNED | IN_PROGRESS --wait--> WAITING
OPEN | ASSIGNED | IN_PROGRESS | WAITING --resolve--> RESOLVED
OPEN | ASSIGNED | IN_PROGRESS | WAITING --cancel--> CANCELLED
RESOLVED --reopen--> IN_PROGRESS (z ownerem) / OPEN (bez ownera)
```

`RESOLVED` i `CANCELLED` są terminalne dla generic edit/assign/priority. `CANCELLED` nie jest resolution ani ścieżką reopen. Poprzednie resolution fields pozostają po reopen, a pełna sekwencja jest w audicie/timeline.

## I. Priority/urgency

Jeden katalog `Low | Normal | High | Urgent` zastępuje dowolne generic writes. Priority ma osobny command z `expectedVersion`, actor i before/after audit; High/Urgent tworzy timeline event. Urgent wpływa tylko na kolejkę i nigdy nie rozszerza permission, nie omija IncidentAssignment i nie zmienia innych domen.

## J. Ownership

Autorytatywny owner to nullable `ownerUserId` z FK do User. Assign/reassign wymaga aktywnego User i aktywnego przydziału do tego samego Incident, sprawdzanego w transakcji; unassign wymaga reason. Actor, previous/new owner i version są audytowane. Owner służy odpowiedzialności i filtrowaniu, nie autoryzacji; uprawnieni operatorzy widzą wszystkie incident Requests, a owner bez `request:read` nadal dostaje `403`.

## K. Cross-domain references

Request może jednocześnie wskazać Enquiry, FamilyRecord, PassengerRecord i ReleaseAction. Service sprawdza incident przy create, a PostgreSQL trigger broni każdego FK przed cross-incident/cross-mode zapisem, także przy bezpośrednim SQL/Prisma. API ukrywa nawet surowy linked ID, gdy actor nie posiada odpowiedniego source-domain read permission.

## L. Domain independence

Request commands nie wywołują Passenger/Family/Enquiry/Matching/Release commands. Real PostgreSQL test snapshotuje powiązane rekordy, wykonuje resolve i potwierdza niezmienione versions/status/hold/verification/release. Nie istnieje side-effect typu hold clear, Family verify, match confirm ani release authorize/complete.

## M. API contract

- `GET /requests/queue`, `GET /requests/assignees`, `GET /requests/:id`
- `POST /requests`, `PATCH /requests/:id`
- `POST /requests/:id/assign`, `/unassign`, `/priority`, `/start`, `/wait`
- `POST /requests/:id/resolve`, `/reopen`, `/cancel`
- `GET /requests` — deprecated/read-only compatibility list

Queue obsługuje search, status, priority, owner/unassigned, due/overdue/none, category, sort, limit i offset. Stare `/assign-to-me` i `/status`, hard delete oraz legacy import write nie istnieją.

## N. Security / IncidentContext

Każde wywołanie przechodzi authentication → istniejące `request:*` permission → aktywny `IncidentAssignment` → `IncidentContext` → RequestService/Repository. Write ponownie sprawdza writable incident oraz przydział aktora wewnątrz serializable transaction. Revoke daje `404` przy następnym list/get/assignees/create/edit/assign/priority/start/wait/resolve/reopen/cancel. REAL i EXERCISE są rozdzielone; Closed/Archived pozwala na read i blokuje wszystkie writes `409`.

## O. Permissions

Zachowano istniejący katalog singular: `request:read`, `request:create`, `request:update`, `request:assign`, `request:close`. `request:update` obejmuje korektę facts, start/wait i priority, ale nie owner ani terminalne decyzje. `request:assign` obejmuje ownership. `request:close` obejmuje resolve/reopen/cancel. Nie utworzono nowych permission bez potrzeby.

## P. Optimistic concurrency / idempotency

Każdy write wymaga `expectedVersion` poza create, który zaczyna od version 1. Conditional update i serializable transaction zwracają `409` dla stale operatora; UI nie auto-retry controlled command. Create/resolve/reopen/cancel wymagają `operationId`. Ten sam incident + operation ID + fingerprint zwraca ten sam committed rezultat; inne dane/command dają `409`. UI zachowuje operation ID po błędzie/timeout i zmienia go dopiero po sukcesie.

## Q. Audit/timeline

Create, ownership, priority, lifecycle i terminalne decyzje zapisują mutację, audit i właściwy timeline event w jednej transakcji. Audit zawiera actor, incident, Request UUID/operational ID, action, before/after status/owner/priority, reason/outcome, version, request/correlation ID i server timestamp bez kopiowania linked PII. Zwykła korekta notatki nie zaśmieca timeline.

## R. Legacy backfill

Migracja zachowuje timestamps i mapuje Open/Assigned/In progress/Waiting/Done/Closed/Completed/Cancelled do FSM. Priority spoza istniejącego katalogu staje się Normal z oryginałem w metadata. Owner label przechodzi do FK wyłącznie przy dokładnie jednym User o tym display name; w przeciwnym razie pozostaje `legacyOwnerLabel` i null FK. Stare linked IDs są zachowane w metadata, a ewentualne cross-incident linki są odpinane zamiast prezentowane jako prawidłowe. Historyczny terminal timestamp jest uczciwym przybliżeniem z zachowanego `updatedAt`; actor/outcome/transition records nie są wymyślane, a brak historii jest jawny w `legacyMetadata`. Kontrolowany CI rehearsal ma: 2 legacy inputs, 2 migrated Requests, 0 owner matches, 1 unresolved owner label, 1 zachowany same-incident zestaw links, 1 bezpiecznie odpięty cross-incident link i 0 sfabrykowanych operations/transition records.

## S. Frontend/UX

Dedykowany `RequestsPage` zastępuje generic `RecordsPage`. Pokazuje operacyjną kolejkę, tekstowy priority/status/Overdue, owner/due/updated, świeży detail i minimalny linked context. Dostępne akcje wynikają z permission i FSM; detail pokazuje resolution, reopen oraz cancellation provenance. Dialog zachowuje focus/keyboard behavior. Stale `409` ma wymagany polski komunikat i wymaga jawnego refresh.

## T. Scale/search/paging

Frontend nie wykonuje fetch-all. PostgreSQL count/list stosuje incident scope, filtry i stabilne sortowanie z limitem maksymalnie 200. Indeksy odpowiadają kolejkom status/update, priority/status, owner/status i dueAt. Test na 1000 rekordach pokrywa paging, search, status, priority, overdue i owner queue.

## U. Legacy removed + LOC

Usunięto Request writes z generic memory routera, starego Prisma routera, generic status/owner PATCH, stare schemas, `assign-to-me`, `/status` oraz direct import create. Pozostałe `requests.splice` służy tylko hydratacji read-only projection; bez write-back. Stare moduły czytają historyczne status labels wyliczane z PostgreSQL.

```text
demo-router.ts before:    4379
demo-router.ts after:     4381

routes/index.ts before:   1811
routes/index.ts after:    1691

RequestsPage.tsx before:     0 (plik nie istniał; używany był RecordsPage)
RequestsPage.tsx after:    998

RecordsPage.tsx before:   1232
RecordsPage.tsx after:    1177
```

Integracja modularnego routera dodała dwa wiersze netto do `demo-router.ts`; legacy `routes/index.ts` zmalał o 120 wierszy, a request-specific fragment `RecordsPage` został usunięty.

## V. Tests

- Prisma validate: PASS.
- Typecheck: PASS.
- API unit/memory: PASS — 96/96.
- Real PostgreSQL 16 fresh migration/seed/startup, Stage 1–7: PASS — 44/44, zero skipped lokalnie oraz w zdalnym Foundation PostgreSQL Gate.
- Pełny backfill rehearsal z pre-Stage-2 fixture do Stage 7: PASS lokalnie oraz w zdalnym Foundation PostgreSQL Gate.
- Build: PASS (wyłącznie istniejące ostrzeżenie Vite o rozmiarze chunku).
- Browser: PASS — 60/60.
- Stage 7 PostgreSQL suite pokrywa migration assets/constraints/indexes/triggers, restart persistence, granular permissions, owner ≠ authorization, assign/reassign, FSM/bypass/no-delete, resolution/reopen/cancel, audit/timeline, concurrency, idempotent retry, EXERCISE/REAL isolation, pełny revoke, closed incident, wszystkie cztery same-incident references na service i DB, permission intersection, linked-domain independence i kolejkę 1000 rekordów.

## W. CI

Branch: `agent/foundation-stage-7-requests`. Implementacja: `cac011dd63e408c556c35bdaf414e1f9965a0029`; poprawka wykryta przez real PostgreSQL: `92b828f`. PR: #4. Po oficjalnej awarii GitHub Actions bieżący SHA `ebe7beb2c643142d0c254509ba22a307622df20d` otrzymał zdalny run `31129242894`.

Foundation PostgreSQL Gate zakończył się PASS: fresh migration, seed, startup, wszystkie real PostgreSQL suites 44/44 bez skipped oraz backfill rehearsal. Quality zakończył się PASS: Typecheck, Unit 96/96, Build i Browser 60/60. Jedynym czerwonym jobem pozostał niesuppressowany Dependency Audit, a jego log zawiera wyłącznie zaakceptowany `GHSA-qwww-vcr4-c8h2`; nie pojawiły się nowe security findings ani regresje.

## X. Remaining split-brain

- Dashboard, Active Event, Reports i Exports nadal konsumują wewnętrzną `RequestCompatibilityRecord[]`; jest ona hydratowana tylko z PostgreSQL i nie ma write-back.
- Notifications nadal są memory/derived i nie mają outboxu; Request correctness nie zależy od notification i Stage 7 nie dodaje nowych notification writes.
- AssignmentTask pozostaje osobnym, legacy split-brain workflow z generic memory/old Prisma paths. Nie jest Request ownerem ani autoryzacją, ale jest najbliższym pozostałym pionowym zobowiązaniem operacyjnym.
- `caseId` pozostaje tekstem kompatybilności do czasu osobnej świadomej decyzji Person/Case.

Nie istnieje drugi production Request command implementation ani production Request dual-write.

## Y. Risks

1. React Router `GHSA-qwww-vcr4-c8h2` pozostaje zaakceptowanym, niesuppressowanym dependency advisory.
2. Read-only compatibility arrays nadal utrzymują starych konsumentów do czasu ich osobnych migracji.
3. Globalny outbox nie istnieje; przyszłe zewnętrzne notifications wymagają osobnego niezawodnego mechanizmu.
4. Legacy terminal timestamp opiera się na zachowanym `updatedAt`, bo stary model nie miał osobnego czasu decyzji; provenance opisuje to ograniczenie.
5. Jednoznaczne mapowanie ownera po display name jest konserwatywne, ale historyczny label może pozostać bez FK, gdy nazwa jest niejednoznaczna.
6. Queue zweryfikowano na 1000 rekordach; większa skala wymaga obserwacji query plans i ewentualnego indeksu tekstowego.
7. `caseId` nie ma integralności relacyjnej, świadomie poza zakresem Stage 7.

## Z. Next decision

```text
READY FOR NEXT FOUNDATION SLICE
```

Rekomendowany następny pionowy slice: **Assignments Persistence + Ownership + Controlled Workflow**.

AssignmentTask jest najbliższym pozostałym incidentowym workflow, który nadal ma równoległe memory i old Prisma write paths. Jego migracja domknie kolejny autorytatywny obszar odpowiedzialności operacyjnej bez mieszania go z ukończonym Request ownership ani rozszerzania tego slice’a.
