# Foundation Stage 11 — Training Report

## A. Stage 10 merge verification

- PR #7 miał finalny HEAD `6fd229d4610426596675456f91bd7a776321a763`, był mergeable/clean i miał zielone Foundation PostgreSQL, Quality, Browser oraz dependency audit bez findings.
- PR #7 został oznaczony Ready i scalony standardowym merge commitem `bf01210a9933f2ac4cb6841aaddcfa09d6d66ae4`.
- Stage 10 HEAD jest przodkiem `origin/main`; Stage 11 rozpoczęto na `agent/foundation-stage-11-training` z tego merge commita i czystego worktree.

## B. Current Course contract

Audyt przed kodowaniem wykazał kompletny kontrakt w `apps/api/src/training.ts`, ale wyłącznie w pamięci: list/get, create/update, deactivate/reactivate, `normalizedCode`, validity, delivery type i `selfCompletable`. Frontend korzystał z tych endpointów, Prisma nie miała modelu Course, a produkcyjny zapis wykonywał `courses.push`/`Object.assign`. Stage 11 zachowuje API i business IDs, lecz przenosi authority do PostgreSQL.

## C. Current Requirement contract

Requirement miało course, jeden z targetów Role/Group/MemberProfile, Required/Recommended, due/effective dates oraz lifecycle end. Przed Stage 11 target integrity, role catalog, duplicate policy, dynamic applicability i resolved count były application-only, w tym fuzzy authority i bounded resolution. Stage 11 wprowadza exact target DB check, jawny katalog dziewięciu ról, dynamiczną resolution bez limitu 200, durable lifecycle i wersję.

## D. Current Training Record contract

MemberTrainingRecord miało assign/start/complete/verify/waive/cancel, due/expiry/score/reference oraz own/manager actions, lecz rekord, provenance i concurrency były pamięciowe. `Expired` zależało od import-time `now`, a completion/verification nie miały wystarczająco jawnej semantyki. Stage 11 zapisuje facts i transitions w PostgreSQL, używa kontrolowanego zegara, expectedVersion oraz operation ledger.

## E. Domain boundaries

- TrainingCourse jest globalnym katalogiem, nie incidentem ani dokumentem.
- TrainingRequirement deklaruje potrzebę szkoleniową; nie jest ukończeniem.
- MemberTrainingRecord jest historią przypisania i wykonania przez MemberProfile; nie jest Requirement.
- Verification jest dodatkowym human provenance nad completion, nie drugim completion.
- MemberProfile, OperationalGroup i Session zachowują własny lifecycle; Training przechowuje relacje i read-only projections.
- Stage 11 nie migruje Documents, Readiness jako osobnego source of truth, Notifications persistence, Briefings, Imports ani Admin/Identity.

## F. Global / Group scope model

Course, Role Requirement, Member Requirement i indywidualne rekordy są globalne w sensie audytu (`sessionId=null`). Group Requirement i Group bulk assignment używają rzeczywistego `OperationalGroup.incidentId`, wymagają permission scope oraz aktywnego IncidentAssignment/System Admin override. Otwarty w UI incident nigdy nie jest przypisywany do globalnej operacji Training. REAL/EXERCISE/TRAINING nie przeciekają przez group scope.

## G. Clock correction

Repository i service otrzymują wstrzykiwany `clock.now()`. List filters, effective status, overdue, expiring soon, completion default, expiry i compliance używają tego samego zegara. Testy nie zależą od daty uruchomienia CI.

## H. Expired decision

Wybrano status derived: baza przechowuje `status=Completed` i immutable `expiryAt`; API zwraca `Expired`, gdy `expiryAt < evaluationAt`. Dokładnie na granicy expiry rekord pozostaje Completed i staje się Expired po przekroczeniu granicy. Nie ma codziennego write-back ani schedulera zmieniającego historię.

## I. Completion vs Verification decision

Wybrano Variant A: prawidłowe completion spełnia compliance, a verification jest dodatkowym provenance. Uzasadnienie: dotychczasowy produkt usuwał warning readiness bez oczekiwania na weryfikację, a `selfCompletable` oznacza rzeczywistą ścieżkę samodzielnego ukończenia. UI jawnie pokazuje `Completion recorded · verification pending`; brak verification nie udaje braku completion.

## J. Course model

`TrainingCourse` przechowuje code/normalizedCode, title/description/category/deliveryType, validityMonths, selfCompletable, lifecycle, version, legacy provenance i timestamps. Case-insensitive normalized code ma unique index. Create race daje jednego zwycięzcę. Brak hard delete; inactive history pozostaje czytelna i nie przyjmuje nowych assignments.

## K. Requirement model

`TrainingRequirement` przechowuje Course FK, exact target, Required/Recommended, due/effective window, active/end provenance i version. Exact aktywny duplicate Course+target jest zabroniony przez partial unique index; po explicit end nowa historyczna instancja jest legalna. Partial update zachowuje target i czyści pola niezgodne z nowym targetType.

## L. Role target model

Authority jest skończonym katalogiem: ZPP/TEC Member, ZPP/TEC Group Leader, ZPP/TEC Coordinator, Family Assistance, Welfare, Documentation. Mapping jest exact i oparty na pool, durable active GroupMembership, linked UserRole lub exact assignedFunction. Nie ma fuzzy substring matching. Test rozwiązuje ponad 1000 Members, w tym osoby poza pierwszą stroną.

## M. Group target model

Group target wskazuje durable OperationalGroup i rozwiązuje aktualne, nieusunięte GroupMembership. Create/update wymaga aktywnego Group, właściwego group scope i IncidentAssignment do jego incidentu. Bulk assignment bierze zablokowany, spójny snapshot membership i aktywnych Members; późniejsza zmiana membership nie przepisuje utworzonej historii.

## N. Source Requirement integrity

Assignment z `sourceRequirementId` wymaga aktywnego/effective Requirement, tego samego Course i applicability dla każdego wybranego Member. Composite FK `(sourceRequirementId, courseId)` blokuje zapis z Course innego Requirement także poza service. Historyczny rekord zachowuje source po zakończeniu Requirement.

## O. MemberTrainingRecord model

Trwały rekord zawiera business `operationalId`, Member/Course/source refs, assigned/due, base status, start/completion/verification/waiver/cancel facts, score/reference, expiry snapshot, version i legacy provenance. Partial unique index chroni przed dwoma aktywnymi Assigned/In Progress dla Member+Course. Completed, Waived i Cancelled pozostają historią.

## P. FSM

```text
Assigned -> In Progress | Completed | Waived | Cancelled
In Progress -> Completed | Waived | Cancelled
Completed -> optional one-time Verification
Waived -> terminal
Cancelled -> terminal
```

Każdy transition sprawdza version i aktualny stan w transakcji. Competing start, complete-vs-cancel, complete-vs-waive i verification mają jednego zwycięzcę; loser dostaje kontrolowany 409.

## Q. Self completion

`training:complete-own` działa wyłącznie dla MemberProfile linked do bieżącego User oraz Course z `selfCompletable=true`. Target nie pochodzi z payloadu klienta. `training:complete-all` pozostaje jawną manager capability.

## R. Verification

Verification jest pojedynczym immutable human action na Completed record. Zapisuje `verifiedById`, relację do User i `verifiedAt`; DB wymusza actor/time pair i Completed status. Drugi verifier nie nadpisuje pierwszego. Retry tego samego operationId zwraca committed snapshot. UI pokazuje pending albo „Verified by … at …” w kolejce, kartach own i drawerze.

## S. Waiver / Cancel provenance

Waive i Cancel wymagają jawnego powodu oraz zapisują actor/time. DB wymusza kompletność provenance dla nowych terminalnych rekordów. Legacy seed nie fabrykuje actor/time/reason; wyjątki są oznaczone `legacyImported` i metadata.

## T. Compliance

Compliance dynamicznie rozwiązuje wszystkie applicable active Requirements, grupuje je po Course i wybiera najlepszy historyczny/aktywny MemberTrainingRecord. Required overdue/expired daje Non-compliant, brak lub Recommended gap daje Attention, Completed/Waived daje Compliant, z expiring-soon jako Attention. Completion działa bez verification zgodnie z Variant A.

## U. Permissions / scopes

Read-own widzi wyłącznie linked MemberProfile; nie podnosi dostępu do innych Members ani incidentu. Read-all/assign/complete/verify/waive respektują global lub Group role assignments. Group actions dodatkowo przechodzą IncidentAccess. Archived target nie przyjmuje nowych Requirement/Assignment; archive Member zachowuje istniejącą historię i blokuje dalsze assignment.

## V. Audit attribution

Course i global/member actions zapisują AuditLog z `sessionId=null`. Group Requirement/assignment zapisuje prawdziwy group incident. Audit jest w tej samej transakcji co mutation i zawiera actor, requestId, entity, versions, operationId/counts bez kopiowania PII. Nie ma fikcyjnego active incident.

## W. Idempotency

`TrainingOperation` ma globalnie unique UUID operationId, command fingerprint, optional record ref, resultVersion i stabilny JSON result. Assign individual/group oraz start/complete/verify/waive/cancel są retry-safe. Reuse ID dla innego commandu, targetu lub payloadu daje 409. Bulk replay zwraca identyczne counts i record IDs zamiast ponownie rozwiązywać zmienioną grupę.

## X. Concurrency

Serializable transactions z bounded retry oraz row locks chronią Course, Requirement, Member, Group i membership snapshots. DB unique/index/FK pozostają ostatnią linią ochrony. Pokryte races: code create, deactivate-vs-requirement, requirement update/end, individual/individual, group/group, group/individual, membership removal, archive/assign, start/start, complete/cancel, complete/waive i verifier/verifier.

## Y. Readiness integration

Readiness używa Foundation Training service i tego samego evaluationAt/clock. Training dimension jest wyliczana z PostgreSQL Requirements/Records, bez kopiowania statusu do memory. Completion wpływa na Readiness natychmiast zgodnie z Variant A; unverified jest jawne w szczegółach, nie jest ukrytym blockerem.

## Z. Member derived training state

Member API wywołuje PostgreSQL Training compliance projection i oznacza `derivedFields.trainingStatus=postgres-projection`. List/get są read-only: test potwierdza, że legacyTrainingStatus, Member version i updatedAt nie są modyfikowane.

## AA. Notifications boundary

Po committed assignment router uruchamia istniejący best-effort notification callback. Wyjątek callbacku nie cofa transaction ani nie zmienia odpowiedzi assignment. Notifications persistence/outbox pozostają poza Stage 11; replay operationId nie generuje ponownego callbacku.

## AB. API

- Courses: paged list/get, create/update/deactivate/reactivate.
- Requirements: paged list/get, create/update/end.
- Records: paged list/get, assign individual/group, update facts, start/complete/verify/waive/cancel.
- Queries: bounded limit/offset, search, target/course/category/status/group/member/mine, overdue, expiringWithin i deterministic sort.
- Writes: expectedVersion i UUID operationId tam, gdzie command może mieć ambiguous retry.

## AC. Frontend

Training używa server paging 50 dla Records/Courses/Requirements, server totals dla KPI i bounded Member/Group lookup z server search. Manager widzi member/course/due/status/source/verification/alerts i assigned-vs-skipped dla grupy. Own widzi wszystkie base/derived statusy, overdue, expiring soon i verification. 409 nie jest auto-retry; drawer zachowuje czytelny błąd. Shared DialogSurface utrzymuje focus trap, dirty-close i keyboard semantics.

## AD. Backfill

Przed Stage 11 nie istniała tabela legacy, więc migracja nie fabrykuje SQL rows. Seed przenosi dokładnie 6 Courses, 4 Requirements i 6 MemberTrainingRecords z obecnego memory seed: codes, metadata, targety, links, operational IDs, completion/expiry i istniejącą verification. Brakujące transition actors/times pozostają null z uczciwym legacy provenance. Rehearsal nie tworzy syntetycznych TrainingOperation.

## AE. Scale

PostgreSQL test tworzy ponad 1000 MemberProfiles i 1000 MemberTrainingRecords. Role resolution obejmuje ponad 1000 osób bez page cap. Record query zwraca dokładnie bounded 37 rows z offset 74 i poprawnym total 500; KPI pochodzą z server aggregates, nie z pierwszej strony.

## AF. Legacy removed + LOC

| Plik | Przed | Po | Uwagi |
| --- | ---: | ---: | --- |
| `apps/api/src/training.ts` | 1406 | 1406 | wyłącznie memory/test adapter i compatibility consumer |
| `apps/api/src/demo-router.ts` | 4163 | 4182 | Foundation router; stare Training routes są wyłączone w production |
| `apps/api/src/routes/index.ts` | 1345 | 1353 | Prisma repository i Member projection wiring |
| `apps/web/src/pages/TrainingPage.tsx` | 1120 | 1205 | paging, lookup, versions, operation IDs, verification UX |
| `apps/api/src/modules/training/*` | 0 | 1129 | types/repository/service/router/Prisma adapter |

W PostgreSQL mode nieosiągalne są legacy `courses.push`, `requirements.push`, `records.push` i `Object.assign` write paths. Memory adapter pozostaje dla unit/browser compatibility; nie jest produkcyjnym Training writerem.

## AG. PostgreSQL tests

- Fresh PostgreSQL 16 migration: 14/14 PASS.
- Seed: PASS.
- Startup `/api/health`: PASS, `persistence=postgres`.
- Stage 1–11: **103/103 PASS, zero skipped**.
- Stage 11: **21/21 PASS**.
- Exact legacy rehearsal pre-Stage-2 → Stage 11: PASS; 4 tables, 3 sequences, zero synthetic operations.

## AH. Browser tests

- Nowe Stage 11: 2/2 PASS — paging/totals/filters, own/manager statuses, verification, commands, operationId/version, stale 409, Course/Requirement lifecycle, individual/group assignment, lookup, assigned/skipped i focus.
- Istniejące own Training oraz shared keyboard/dialog/focus scenariusze pozostają zielone.
- Pełny finalny Browser gate: **68/68 PASS**.

## AI. CI

| Gate | Wynik |
| --- | --- |
| Fresh migration / seed / startup | PASS |
| Stage 1–11 PostgreSQL | PASS — 103/103, zero skipped |
| Exact legacy backfill rehearsal | PASS |
| Typecheck | PASS |
| Unit | PASS — 96/96 |
| Build | PASS |
| Browser | PASS — 68/68 |
| Production Dependency Audit | PASS — zero findings |
| Remote GitHub Actions | PASS — Foundation PostgreSQL Gate, Typecheck / Unit / Build / Browser oraz Production Dependency Audit dla SHA implementacyjnego `0b25ed05da539cde05de25792115da2085f35108` |

## AJ. Remaining split-brain

| Kandydat | Rzeczywisty stan po Stage 11 | Kolejność |
| --- | --- | --- |
| Documents | 1312 LOC memory; document lifecycle, requirements i acknowledgements; bezpośrednie wejście Readiness/Notifications | najwyższy spójny write-owning kandydat |
| Readiness | głównie read/evaluation; durable Member/Group/Rostering/Training, lecz memory Documents i policy | po usunięciu brakującego źródła Documents |
| Notifications / Briefings | derived consumers i best-effort memory delivery; briefing zapis w Active Event | ważne, ale sensowniejsze po stabilizacji wszystkich źródeł |
| Imports | memory staging/confirm, lecz Passenger/Family target writes są już durable | węższy split-brain niż Documents |
| Admin / Identity | część User/Role jest PostgreSQL, dużo route-level lifecycle i security policy w memory | krytyczne, lecz większy osobny security slice |

## AK. Risks — max 10

1. Memory adapter może semantycznie odjechać od production repository; oba kontrakty wymagają dalszych testów.
2. Notifications są best-effort i bez durable outbox, więc awaria po commicie może utracić komunikat.
3. Compliance wykonuje dynamiczną resolution Requirements; przy bardzo dużym katalogu wymaga obserwacji query latency.
4. Member list wylicza Training projection per bounded row; przyszły profil wydajnościowy może wymagać batch projection.
5. Group snapshot jest spójny w transakcji, ale operator nadal musi świadomie ponowić controlled 409 przy ekstremalnym contention.
6. Legacy completions mają celowo niepełne actor provenance.
7. Verification jest immutable single action; korekta błędnego verifiera wymaga przyszłego, jawnego correction modelu, nie overwrite.

## AL. Next decision

**Rekomendowany dokładnie jeden następny slice: Documents Persistence + Requirements + Acknowledgement Integrity.**

Uzasadnienie: Documents jest największym pozostałym spójnym primary write ownerem i jedynym niedurable wejściem, które nadal bezpośrednio wpływa na Readiness oraz Notifications. Migracja samego Readiness teraz utrwaliłaby evaluator nad pamięciowym źródłem, Notifications/Briefings są konsumentami, Imports mają już durable target domains, a Admin/Identity wymaga szerszego osobnego security closure. Następny slice nie został rozpoczęty.

## Final verdict

```text
READY FOR NEXT FOUNDATION SLICE
```

Wszystkie lokalne i zdalne gate’y Stage 11 są zielone. Draft PR pozostaje otwarty do przeglądu, a następny slice nie został rozpoczęty.
