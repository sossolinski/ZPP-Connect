# Foundation Stage 10 — Rostering + Availability Report

## A. Stage 9 merge verification

- PR #6 miał finalny HEAD `33baa6fb3433c5ed83ca7e6d4fc93219a3970232`, był mergeable/clean i miał zielone wymagane gate’y oraz zerowy dependency audit.
- PR #6 został scalony standardowym merge commitem `02bc26cfce52a9eea79f962ca35695082105061d`.
- Stage 9 HEAD jest przodkiem `origin/main`; Stage 10 rozpoczęto na `agent/foundation-stage-10-rostering-availability` z tego commita i z czystym worktree.

## B. Current Roster contract

Audyt przed implementacją wykazał jeden kompletny, ale wyłącznie pamięciowy kontrakt w `apps/api/src/rostering.ts`. Nie istniał alternatywny zapis Prisma.

| Operacja | Dotychczasowy endpoint/caller | Frontend | Memory | Prisma przed Stage 10 | Decyzja Stage 10 |
| --- | --- | ---: | ---: | ---: | --- |
| list/get | `GET /roster-shifts[/:id]` | tak | tak | nie | bounded PostgreSQL query |
| create/edit facts | `POST`, `PATCH /roster-shifts` | tak | tak | nie | durable transaction + version |
| publish/confirm/decline/cancel/complete | dedykowane POST commands | tak | tak | nie | jawny FSM + operationId |
| assignee/group/time | generic edit | tak | tak | nie | relacje FK + expectedVersion |
| own/group roster | query + scope policy | tak | tak | nie | IncidentContext + Member/Group scope |
| warnings | obliczane in-memory | tak | tak | nie | read-time PostgreSQL projection, bez mutation |
| audit | route-side memory audit | pośrednio | tak | nie | AuditLog w tej samej transakcji |
| notifications | callback po zmianie | tak | tak | nie | best-effort callback po commicie |
| Readiness/Member/Group | memory projections | tak | tak | nie | read-only projection z durable rows |

## C. Current Availability contract

Przed Stage 10 Availability była globalną listą pamięciową bez `sessionId`. Own wynikało z linku User → MemberProfile, a manage-all ze scope policy. Create/update/remove, typy i overlap działały w pamięci; remove usuwał rekord z bieżącego widoku, a historia nie była durable. Stage 10 zachowuje globalny charakter, wprowadza wersjonowane rekordy Active/Removed, twardą kontrolę own/manage-all i durable consumption przez ostrzeżenia rosteru.

## D. Domain boundaries

- `RosterShift` jest incident-scoped planem obsady, nie IncidentAssignment ani uprawnieniem.
- `Availability` jest globalną deklaracją MemberProfile w czasie, nie stanem incidentu.
- MemberProfile i OperationalGroup pozostają właścicielami swojej tożsamości/lifecycle; roster przechowuje wyłącznie relacje.
- Readiness, Member i Group konsumują projekcje tylko do odczytu. Stage 10 nie przejmuje Training, Documents, Readiness engine ani Notifications persistence.
- Żaden konflikt czasowy nie uruchamia automatycznej decyzji staffingowej.

## E. Roster field classification

- Identity/scope: `id`, `operationalId`, `sessionId`.
- Planning facts: `title`, `duty`, `functionName`, `startAt`, `endAt`, `location`, `notes`.
- Staffing references: `groupId`, `assignedMemberProfileId`.
- Controlled lifecycle: `status`, `version` oraz actor/time dla publish, confirm, decline, cancel i complete.
- Derived: `assignedUserId`, nazwy Member/Group, permissions i warning details.
- Legacy: `legacyImported`, uczciwe `legacyMetadata`; nie są edytowalnym drugim źródłem prawdy.

## F. Availability semantic decision

Wybrano Variant A: jedna globalna deklaracja Availability dla MemberProfile. Potwierdzają to dotychczasowy brak `sessionId`, UI „my availability”, istniejące permissions oraz konsumpcja tego samego okna przez wiele planów. Own Availability nie wymaga IncidentAssignment; wymaga aktywnego linked MemberProfile i `availability:update-own`.

## G. Data model

Dodano `RosterShift`, `Availability` i `RosteringOperation` oraz relacje z Session, OperationalGroup, MemberProfile i User. Migracja zawiera:

- checks dla version, zakresów czasu, statusów i typów;
- composite same-incident FK Group ↔ RosterShift;
- guards blokujące staffing z archived Member/Group i Availability dla archived Member;
- archive guards dla aktywnego rosteru;
- atomowe sekwencje `RosterShift_operational_seq` i `Availability_operational_seq`;
- indeksy odpowiadające filtrom incident/status/member/group/function/time i availability member/type/status/time.

Nie dodano zakazu overlap w bazie, ponieważ overlap jest ostrzeżeniem, a nie automatyczną decyzją.

## H. Assigned Member vs User

`assignedMemberProfileId` jest jedyną authoritative relacją obsady. `assignedUserId` nie jest zapisywane w RosterShift; jest bieżącą projekcją `MemberProfile.linkedUserId`. Member bez konta User może legalnie pozostać w planie. Zmiana linku Member↔User nie przepisuje historycznych shiftów i nie tworzy User automatycznie.

## I. Incident scoping

Każdy roster read/write przechodzi auth → roster permission → IncidentAssignment/System Admin override → IncidentContext → service → repository. Normalny użytkownik bez aktywnego IncidentAssignment otrzymuje 404. Filtr `sessionId` jest obowiązkowy, a Group musi należeć do tego samego incidentu także przy bezpośrednim zapisie SQL.

## J. Own roster policy

Own oznacza aktualny User → aktywny linked MemberProfile → `assignedMemberProfileId`. Nie nadaje dostępu do incidentu. Revocation IncidentAssignment działa od następnego requestu i nie usuwa historycznej obsady.

## K. Own availability policy

Own identity jest wyprowadzana po stronie backendu. Klient z `availability:update-own` nie może wskazać innego MemberProfile. `availability:manage-all` zachowuje istniejący global/group scope; global manager może jawnie wskazać target. Availability nie tworzy fikcyjnego IncidentContext.

## L. Group/member eligibility

Cross-group staffing pozostaje legalny, ponieważ istniejący produkt dopuszcza zasoby rezerwowe i międzygrupowe. Jest jednak oznaczany `OUTSIDE_GROUP`. Archived Member i archived Group są twardo blokowane; inactive Member pozostaje widoczny historycznie i generuje warning. Races archive-vs-assign/create są serializowane.

## M. Status FSM

Dozwolone transitions:

```text
Draft -> Published | Cancelled
Published -> Confirmed | Declined | Cancelled
Confirmed -> Completed | Cancelled
Declined -> Cancelled
Cancelled -> terminal
Completed -> terminal
```

Create zawsze tworzy Draft. Publish, confirm, decline, cancel i complete są dedykowanymi commands. Cancelled i Completed pozostają rozdzielone semantycznie i w provenance.

## N. Conflict warnings

`OVERLAPPING_SHIFT`, `UNAVAILABLE`, `MEMBER_INACTIVE`, `OUTSIDE_GROUP` i `UNASSIGNED` są obliczane jako jawne warning details. Shift overlap i Unavailable overlap nie blokują zapisu i nie zmieniają statusu/assignee. Overlap dwóch aktywnych deklaracji Availability tego samego Member pozostaje 409, aby jedna globalna deklaracja nie była sama ze sobą sprzeczna.

## O. Concurrency

Wszystkie mutacje używają expectedVersion lub operationId. Staffing update, publish-vs-edit, confirm-vs-decline, confirm-vs-cancel oraz Availability update-vs-remove mają dokładnie jednego zwycięzcę. Serializable transactions z bezpiecznym retry transient `40001/P2034` chronią create/lifecycle i archive races; po wyczerpaniu konflikt jest 409, nie 500.

## P. Idempotency

Globally unique UUID `operationId` zapisuje command fingerprint i resultVersion dla:

- create shift;
- publish/confirm/decline/cancel/complete;
- create availability;
- remove availability.

Ponowienie tej samej logicznej operacji zwraca committed rekord z `idempotent: true`; reuse ID dla innego commandu zwraca 409. Zwykły PATCH pozostaje chroniony expectedVersion bez mechanicznego operationId.

## Q. Transactions

Roster command atomowo sprawdza writable incident, wersję/FSM, Member/Group integrity, wykonuje mutation, zapisuje operation (gdy dotyczy) i AuditLog. Availability atomowo sprawdza own/manage-all, Member validity, wersję/overlap, mutation, operation i audit. Notifications nie należą do tej transakcji.

## R. Audit

AuditLog rejestruje actor/request ID, entity/operational ID, incident dla rosteru, command, status/member/group/time/version before/after i operationId. Payload nie kopiuje phone ani contact email. Historyczne seed transitions nie otrzymały fikcyjnych actor/time events.

## S. Notifications boundary

Istniejący notification compatibility callback uruchamia się dopiero po commicie. Publish tworzy powiadomienie, a confirm/decline/cancel/complete rozwiązują source. Każdy callback jest best-effort; test udowadnia, że jego wyjątek nie cofa committed RosterShift.

## T. Member derived projections

Member API wyprowadza structured `availabilitySummary` i `rosterSummary` z PostgreSQL. Legacy strings są oznaczone jako historyczne i nie są authoritative. List/get są read-only: test porównuje Member version/updatedAt przed i po projekcji i potwierdza brak write-back.

## U. Group roster projection

Group `rosterShiftIds` i `rosterLinkCount` wynikają z trwałej relacji RosterShift. Nie są edytowalną tablicą. Aktywny roster blokuje archive Group zarówno w service, jak i w DB race protection.

## V. Backfill

Dotychczasowe roster/availability fixtures istniały wyłącznie w pamięci, więc nie było tabeli legacy do SQL backfill. Seed zachowuje dokładnie 6 shiftów (`RST-001`…`RST-006`) i 4 availability (`AVL-001`…`AVL-004`): IDs, incident, Group/Member refs, statuses, windows i notes. Wszystkie stare shifty mają `legacyImported=true` i metadata `transitionActorsAvailable=false`; status Confirmed/Cancelled/Completed zachowano bez wymyślonych actor/time/reason. Rehearsal migracji pre-Stage-2 → Stage 10 przechodzi i nie tworzy syntetycznych `RosteringOperation`.

## W. API

- `GET /roster-shifts`, `GET /roster-shifts/:id`
- `POST /roster-shifts`, `PATCH /roster-shifts/:id`
- `POST /roster-shifts/:id/{publish,confirm,decline,cancel,complete}`
- `GET /availability`, `POST /availability`, `PATCH /availability/:id`
- `POST /availability/:id/remove`

Listy wspierają limit/offset, filters, own i deterministic sort. Maksymalny page size to 200. Production PostgreSQL router zastępuje stare route’y; memory router pozostaje wyłącznie adapterem testowym.

## X. Frontend / UX

Rostering używa bounded server pages (50), server search/function/status/group/member/date filters i tekstowych statusów. Wszystkie writes wysyłają expectedVersion, a krytyczne commands UUID operationId. 409 pozostawia formularz i pokazuje human-resolvable refresh message bez auto-retry. Warning drawer mówi wprost, że planner musi podjąć decyzję i że warning nie zmienia rosteru automatycznie. Availability ma add/edit/explicit remove, own i manager views. DateTime jest zapisywany jako UTC i prezentowany w lokalnej strefie przeglądarki.

## Y. Scale

Test wstawia 1000 RosterShift i 1000 Availability, po czym weryfikuje filtrowanie, paging, offset, type/function i deterministic sort bez fetch-all. Dodatkowo burst 20+20 tworzy unikalne operational IDs przy równoległym create.

## Z. Legacy removed + LOC

| Plik | Przed | Po | Uwagi |
| --- | ---: | ---: | --- |
| `apps/api/src/rostering.ts` | 804 | 804 | wyłącznie memory/test adapter; production routes są wyłączone |
| `apps/api/src/demo-router.ts` | 4143 | 4163 | foundation service/router + read-only compatibility |
| `apps/api/src/routes/index.ts` | 1338 | 1345 | production Prisma repository wiring |
| `apps/web/src/pages/RosteringPage.tsx` | 847 | 897 | paging, versions, operation IDs, warning UX |
| `apps/api/src/modules/rostering/*` | 0 | 1175 | types/repository/service/router/Prisma adapter |

W production nie ma już `shifts.push`, `availability.push`, memory counters ani `createRosteringRepository` jako write path. Pozostawienie adaptera jest świadome dla memory-mode unit/browser compatibility.

## AA. PostgreSQL tests

Fresh PostgreSQL 16:

- 13/13 migrations: PASS;
- seed: PASS;
- startup `/api/health` z `persistence=postgres`: PASS;
- Stage 1–10: **82/82 PASS, zero skipped**;
- Stage 10: 15/15 PASS;
- exact legacy backfill rehearsal: PASS.

Zakres obejmuje persistence/restart, REAL/EXERCISE/TRAINING, incident isolation/revoke/own non-elevation, own/manage-all Availability, same-incident DB defence, archive races, wszystkie wymagane command races, warnings-without-mutation, notification failure, backfill honesty, scale i no-write-back projections.

## AB. Browser tests

- Istniejący pełny smoke suite: 63/63 PASS.
- Nowe Stage 10: 3/3 PASS — bounded pages/filters, edit/publish, warning separation, stale 409, UUID operationId, confirm/decline/cancel/complete, own Availability add/edit/remove/isolation.
- Pełny finalny Browser gate po dodaniu testów: **66/66 PASS**.
- Wspólne accessibility/focus/dirty-form tests pozostają częścią pełnego suite.

## AC. CI

Stan lokalny:

| Gate | Wynik |
| --- | --- |
| Fresh migration / seed / startup | PASS |
| Stage 1–10 PostgreSQL | PASS — 82/82, zero skipped |
| Legacy backfill rehearsal | PASS |
| Typecheck | PASS |
| Unit | PASS — 96/96 |
| Build | PASS |
| Browser | PASS — 66/66 |
| Dependency Audit | PASS — zero findings |
| Remote GitHub Actions | PASS — Foundation PostgreSQL Gate, Typecheck/Unit/Build/Browser i Production Dependency Audit |

## AD. Remaining split-brain

Po Stage 10 główne pozostałe write-owning obszary pamięciowe to:

| Kandydat | Obserwowany rozmiar/zapis | Zależności |
| --- | --- | --- |
| Training | 1406 LOC; 12 write commands dla course/requirements/records | bezpośrednio zasila Readiness, Member status, roster planning i notifications |
| Documents | 1312 LOC; version/publish/withdraw/requirements/acknowledgement | bezpośrednio zasila Readiness i notifications |
| Readiness | 697 LOC | dependency-central, ale głównie read/evaluation, nie primary write owner |
| Notifications | 946 LOC | derived consumer wielu domen, persistence nadal memory |
| Briefings | część 916-LOC Active Event | write-owning, lecz węższy wpływ operacyjny |
| Imports | route-level staging/confirm | istotne wejście, ale Passenger/Family mają już domain imports |
| Admin/Identity | wiele route-level writes w `demo-router.ts` | krytyczne security, lecz część User/Role/Group scope jest już w PostgreSQL i wymaga osobnego, szerokiego closure |

Największym jednocześnie write-owning i dependency-central spójnym pionem jest obecnie Training.

## AE. Risks — max 10

1. Memory adapter może semantycznie odjechać od production PostgreSQL; kontraktowe testy trzeba utrzymywać równolegle.
2. Serializable retry ma skończony limit; ekstremalny contention kończy się kontrolowanym 409 i wymaga ręcznego retry.
3. Cross-group staffing jest legalny, więc operator musi świadomie obsłużyć `OUTSIDE_GROUP` warning.
4. Notifications nadal są best-effort i pamięciowe; brak durable outbox pozostaje poza Stage 10.
5. Readiness nadal łączy durable Rostering/Availability z pamięciowymi Training/Documents.
6. Legacy terminal roster records mają celowo niepełne transition provenance.
7. Bounded warnings są dokładne dla zwróconego zakresu czasowego, ale przy dalszym wzroście danych wymagają obserwacji query latency.

## AF. Next decision

**Rekomendowany dokładnie jeden następny slice: Training Persistence + Requirements / Completion / Verification Concurrency Safety.**

Uzasadnienie: Training ma największy pozostający spójny write model (courses, requirements i member records), więcej jawnych commandów niż Documents i jest bezpośrednim wejściem do Readiness, Member derived state, roster planning oraz Notifications. Jego migracja usuwa więcej dependency-central split-brain niż migracja samego read-only Readiness engine. Następny slice nie został rozpoczęty.

## Final verdict

```text
READY FOR NEXT FOUNDATION SLICE
```

Powód: fresh PostgreSQL, pełny Stage 1–10, exact backfill, quality/browser, dependency audit i rzeczywiste remote GitHub Actions są zielone. PR pozostaje Draft zgodnie z wymaganym stanem końcowym; następny slice nie został rozpoczęty.
