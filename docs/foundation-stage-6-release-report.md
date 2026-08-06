# Foundation Stage 6 — Release / Reunification Report

## A. Stage 5 merge verification

- PR #2 obejmował Foundation Stage 5 Matching, był mergeable i bez konfliktów.
- Foundation PostgreSQL Gate oraz Typecheck/Unit/Build/Browser były zielone. Jedynym czerwonym jobem był zaakceptowany advisory React Router `GHSA-qwww-vcr4-c8h2`; nie pojawiły się nowe findings.
- Draft został zdjęty, a PR scalono standardowym merge commit do `main`: `751bc31f60c2a895e9571a319668d728fc5db99d`.
- Commit Stage 5 `a2b58e768227fd2c7a917216076d964b9d27b1ce` jest przodkiem `origin/main`. Stage 6 rozpoczęto z czystego, aktualnego `main` na `agent/foundation-stage-6-release`.

## B. Current Release contract

Stan zinwentaryzowany przed implementacją:

| Operation | Endpoint/caller | Frontend | Legacy memory | Old Prisma | Stage 6 decision |
| --- | --- | ---: | ---: | ---: | --- |
| List queue | `GET /releases` | fetch-all | pełna tablica | równoległy list router | `GET /releases/queue`, paging/search/status/eligibility/type/sort na serwerze |
| Get/context | generic detail/list row | składany z wielu list | lookup tablicy | raw include | `GET /releases/:id`, gotowy decision context |
| Prepare | generic create | create form | bezpośredni push | direct create | `POST /releases/prepare`; tworzy tylko `PREPARED` |
| Identity check | boolean w create/PATCH | checkbox | mutowalne `identityChecked` | mutowalne pole | explicit `ReleaseCheck(IDENTITY)` z actor/time/basis/input refs |
| Hold check | boolean w create/PATCH | checkbox | mutowalne `holdCleared` | mutowalne pole | explicit `ReleaseCheck(HOLD_REVIEW)`; nigdy nie zmienia Passenger hold |
| Final authorization | łączone z completion/shortcut | brak odrębnego kroku | status mutation | status mutation | `POST /releases/:id/authorize`, świeża ewaluacja i human reason |
| Complete/reunited/released | release completion + Matching shortcuts | akcja końcowa | automatyczne booleany/status | bezpośrednie writes | `POST /releases/:id/complete`, oddzielone od authorization |
| Cancel | generic status update | generic edit | status mutation | status mutation | `POST /releases/:id/cancel`, expectedVersion/reason/operationId |
| Reopen/amend | generic PATCH mógł przepisać stan | generic edit | dowolna mutacja | dowolna mutacja | brak generic reopen/amend; terminal history immutable, nowa akcja po świadomej korekcie |
| `mark-reunited` | Matching action | button/DnD shortcut | ustawiało release + check booleans | stary shortcut | usunięte i testowane jako `404` |
| `mark-released` | Matching action | button/DnD shortcut | ustawiało release + check booleans | stary shortcut | usunięte i testowane jako `404` |
| Generic CRUD | `/releases/:id` create/update/delete | formularz | aktywne writes | aktywne writes | brak publicznego POST/PATCH/DELETE; wyłącznie commands |
| Matching dependency | raw `MatchingRecord.status` | składanie w React | legacy status | legacy status | tylko current human `MatchDecision`/Stage 5 projection |
| Family/NOK dependency | flat verification fields | fetch-all | flat state | raw join | current `RelationshipClaim VERIFIED` i zapisany version |
| Passenger dependency | raw Passenger + release boolean | fetch-all | możliwość shortcutu | raw update | current Passenger/version/hold; hold zmieniany tylko w Passenger workflow |
| Audit/timeline | częściowy/generic | niejawny | osobne writes | nieatomowe ścieżki | command + operation + audit + timeline w jednej transakcji |
| Report/export/requests/dashboard | raw legacy release array | read consumers | memory | raw records | read-only compatibility projection, bez write-back |

## C. Field classification

| Class | Fields | Stage 6 resolution |
| --- | --- | --- |
| References | incident, Passenger, Family, Matching | `incidentId`, `passengerRecordId`, current `relationshipClaimId`, current human `matchDecisionId`; `matchingRecordId` tylko compatibility |
| Eligibility inputs | relationship/match/hold/condition/source + versions | claim status/current/version, decision/current/input versions, Passenger version/current hold; condition pokazane informacyjnie, bez wymyślonej policy |
| Independent checks | `identityChecked`, `holdCleared` | append/history-preserving `ReleaseCheck` z type/result/actor/time/basis/evidence reference/input refs/currentness |
| Controlled decisions | status, completion/notes | prepare, authorize, complete i cancel jako osobne commands z aktorem, czasem i reason |
| Technical | ID/timestamps | PostgreSQL sequence operational ID, version, operation ledger/fingerprint, request ID, server timestamps |
| Legacy/unsafe | booleany, generic status PATCH, `mark-*`, override-like bypass | usunięte z write contract; stare booleany wyłącznie w jawnej read-only projection/backfill metadata |

## D. Release vs Reunification semantics

`RELEASE` i `REUNIFICATION` są odrębnymi typami operacyjnej akcji. Korzystają z tego samego bezpiecznego FSM i preconditions, ale zachowują osobny outcome i timeline event. `RELEASE` przy completion wymaga receiving party; `REUNIFICATION` pozostaje osobnym kontrolowanym procesem dla konkretnego NOK/matcha. System nie utożsamia żadnego z nich z samym `AUTHORIZED`.

## E. Target architecture

Jedyny command contract to `ReleaseService` + `ReleaseRepository`, z PostgreSQL jako production source of truth i memory adapterem testowym. `ReleaseAction` przechowuje proces i decyzje, `ReleaseCheck` niezależne checks, a `ReleaseOperation` techniczny ledger idempotency. Istniejący `IncidentAccessService` pozostaje jedyną warstwą incident authorization. Nie dodano frameworka DDD ani workflow engine.

## F. ReleaseAction model

Model zawiera incident/type/status, referencje claim/decision/Passenger, przygotowane i autoryzowane input versions, destination/recipient/transport notes, optimistic `version`, osobnych prepared/authorized/completed/cancelled actors i timestamps/reasons oraz jawne legacy provenance. Partial unique indexes blokują drugi aktywny proces oraz drugi completed outcome dla incident + claim + decision + action type. Constraints wymagają dla nowych rekordów pełnych referencji i aktorów; historyczne wyjątki są dozwolone tylko z `legacyImported=true`.

## G. ReleaseCheck model

`IDENTITY` i `HOLD_REVIEW` są osobnymi rekordami z result, actor, server time, basis, bezpieczną opcjonalną evidence reference, claim/decision/Passenger input refs, `operationId`, version/currentness i supersession. Partial unique dopuszcza jeden current check danego typu na akcję. Trigger odrzuca cross-incident link, check dla terminalnej akcji oraz input refs niezgodne z akcją. Historyczny boolean nigdy nie staje się checkiem.

## H. FSM

Dozwolone publiczne przejścia:

```text
PREPARED → AUTHORIZED → COMPLETED
PREPARED → CANCELLED
AUTHORIZED → CANCELLED
```

`BLOCKED` i `REQUIRES_REVIEW` są dynamicznym effective state, a nie arbitralnie mutowanym statusem. Nie ma generic PATCH statusu. `COMPLETED` jest chroniony triggerem przed rewrite. Authorization i completion są oddzielnymi human commands.

## I. Eligibility rules

Prepare wymaga current `RelationshipClaim VERIFIED` oraz current human `MatchDecision CONFIRMED` ze zgodnymi claim/Passenger versions. Authorize i complete ponownie sprawdzają writable incident, current claim, current decision, zgodnego Passenger, prepared inputs, explicit identity PASS, current Passenger hold, current Stage 5 matching hold i current hold review. Condition/SRC są eksponowane w decision context, ale nie dodano nieuzasadnionej reguły blokującej.

## J. Identity verification

Identity PASS/FAIL jest jawnym human checkiem. Zapisuje aktora, czas, podstawę, opcjonalny typ/referencję evidence i input versions. Nie przechowuje numeru dokumentu w audicie. Nie może zostać ustawiony przez prepare, authorize, complete, generic PATCH ani stary shortcut.

## K. Hold interaction

Release odczytuje bieżący Passenger hold, lecz nigdy go nie zmienia. `HOLD_REVIEW` rejestruje, że operator sprawdził aktualny stan; jego wynik jest wyliczony z fresh Passenger read. Pojawienie się holda po PREPARED blokuje authorization, a po AUTHORIZED blokuje completion. Zdjęcie holda wymaga kontrolowanego Passenger Stage 3 workflow i nowego current review.

## L. RelationshipClaim interaction

Akcja wskazuje konkretny claim i version. Correction/reopen/reject/current-claim replacement nie przepina istniejącej akcji; daje `REQUIRES_REVIEW`/blocker. Authorization i completion wymagają, aby dokładnie ten claim nadal był current oraz VERIFIED.

## M. MatchDecision interaction

Release nie ufa `MatchingRecord.status`. Wymaga wskazanego `MatchDecision` z `decision=CONFIRMED`, `validity=CURRENT`, `isCurrent=true`, zgodnym claimem, Passenger i input versions. Invalidation/supersession natychmiast blokuje istniejącą akcję bez agresywnego cascade update.

## N. Passenger interaction

Akcja i checks zapisują Passenger ID/version bez kopiowania PII snapshotu. Meaningful Passenger source correction lub hold change unieważnia prepared/current check inputs. ReleasePage odsyła uprawnionego operatora do właściwego Passenger workflow; nie zawiera hold mutation.

## O. API contract

- `GET /releases/queue`
- `GET /releases/candidates`
- `GET /releases/:id`
- `POST /releases/prepare`
- `POST /releases/:id/checks/identity`
- `POST /releases/:id/checks/hold`
- `POST /releases/:id/authorize`
- `POST /releases/:id/complete`
- `POST /releases/:id/cancel`
- `GET /releases` — jawnie deprecated/read-only compatibility projection

Queue ma server-side search, status, eligibility, action type, sort i paging. Candidates mają search, eligibility, sort i paging. Nie ma publicznego create/update/delete ani shortcut endpoints.

## P. Security / IncidentContext

Każdy request przechodzi authentication → granularne `release:*` permission → `IncidentAssignment` → `IncidentAccessService` → ReleaseService/Repository. Revoke pełnoprawnego operatora daje `404` dla list/get/prepare/check/authorize/complete przy następnym request. Closed/Archived pozostaje read-only. REAL/EXERCISE/TRAINING są rozdzielone przez incident scope; service i PostgreSQL triggery odrzucają cross-incident claim/decision/Passenger/check/operation links.

## Q. Permission separation

Katalog rozdziela `release:read`, `release:prepare`, `release:check`, `release:authorize`, `release:complete` i `release:cancel`. Testowi aktorzy dowodzą, że read/preparer/checker/authorizer/completer nie przejmują sąsiednich praw. Nie istnieje `release:update` obejmujące decyzje. Nie wymyślono fikcyjnego dual control; model zachowuje oddzielnych aktorów, a ewentualna reguła checker != authorizer pozostaje świadomą decyzją policy.

## R. Concurrency / idempotency

Każda mutacja wymaga `expectedVersion`; conditional update i serializable transaction dają bezpieczne `409` dla stale operatora. `operationId` + command fingerprint zapisane w `ReleaseOperation` obsługują prepare/check/authorize/complete/cancel. Retry po utracie odpowiedzi zwraca ten sam committed result; użycie ID dla innej komendy/akcji daje `409`. Real PostgreSQL race dwóch authorize ma jeden logiczny sukces. DB indexes chronią aktywny proces i completed outcome.

## S. Stale/revalidation semantics

Eligibility jest liczona z fresh relational reads. Claim change, decision invalidation, Passenger version change lub hold powodują jawne blockers i `REQUIRES_REVIEW`/`BLOCKED`. Authorize/complete nigdy nie auto-retry po `409`; UI zachowuje operation ID wyłącznie dla bezpiecznego retry po timeout i wymaga refresh/review dla konfliktu. Nie ma coordinator override omijającego podstawy bezpieczeństwa.

## T. Audit/timeline

Prepare/check/authorize/complete/cancel zapisują audit i operacyjny timeline w tej samej PostgreSQL transaction co command. Audit zawiera actor, incident, action/Passenger/claim/decision IDs, check result lub reason/basis, input versions, operation/request IDs, before/after state i server timestamp, bez zbędnego PII. Timeline zapisuje tylko istotne zdarzenia, nie techniczne eligibility refresh.

## U. Legacy backfill

Migracja zmienia `ReunificationReleaseRecord` w `ReleaseAction`, mapuje typ/status/referencje i zachowuje terminal timestamps. Historyczne `identityChecked`/`holdCleared` trafiają tylko do `legacyMetadata`; ustawiane są `legacyImported` i `verificationEvidenceUnavailable`, a `ReleaseCheck` nie jest fabrykowany. Historyczne duplikaty controlled key pozostają audytowalne, ale są jawnie kwarantannowane z null `matchDecisionId` i metadata, aby nie blokować bezpiecznych indeksów. Rehearsal sprawdza dokładnie jeden fixture legacy z zero checks.

## V. Frontend/UX

`ReleasePage` jest server-driven: kolejka i candidates są paged, a backend zwraca gotowy decision context. Passenger, NOK, match i siedem preconditions są pokazane osobno; checks pokazują actor/time/result/basis/currentness. Nie ma checkboxów. Dialogi obejmują prepare, identity, hold review, authorize, complete i cancel. REAL authorize/complete pokazuje wyraźne ostrzeżenie, osoby, typ akcji i wszystkie critical preconditions. Active Passenger lub Matching hold jest nazwany blockerem; Passenger hold prowadzi do właściwego Passenger workflow. Conflict `409` pozostawia formularz otwarty i nie wykonuje auto-retry.

## W. Legacy removed + LOC

Usunięto aktywne memory i stare Prisma Release CRUD, `mark-reunited`, `mark-released`, boolean/status mutation, unsafe validation schemas oraz równoległe completion writes. Pozostała tylko odczytowa projection dla legacy consumers.

```text
demo-router.ts before: 4482
demo-router.ts after:  4379

routes/index.ts before: 1991
routes/index.ts after:  1811

ReleasePage.tsx before: 745
ReleasePage.tsx after:  336
```

## X. Tests

- Prisma validate/generate: PASS.
- Typecheck/lint: PASS.
- API unit/memory: PASS (`98 passed`; PostgreSQL suites lokalnie skipped bez `TEST_DATABASE_URL`, zero skipped w remote gate).
- Build: PASS.
- Browser: PASS (`59/59`), w tym pełny FSM, explicit checks, no-checkbox, REAL confirmation, stale/hold blocker, completion i `409` bez auto-retry.
- Stage 6 PostgreSQL suite obejmuje fresh migration assets/constraints/triggers, persistence/restart, granular permissions, dangerous shortcuts/generic bypass, current hold independence, fresh authorize/complete revalidation, claim/match/Passenger changes, revoke, closed incident, same-incident/cross-mode, multiple NOK, real authorize concurrency, operation retry/misuse, duplicate completion, terminal immutability, 1000-row paging i honest legacy provenance.
- Backfill rehearsal wdraża Stage 1–6 na pre-Stage-2 fixture i sprawdza migrated Release bez sfabrykowanych checks.

## Y. CI

Foundation PostgreSQL Gate obejmuje fresh deploy/seed/startup, Stage 1, 2, 2.5, 3, 4, 5 i 6 integration tests oraz rozszerzony backfill rehearsal. Quality uruchamia Typecheck, Unit, Build i wszystkie Browser smoke. Dependency Audit pozostaje niesuppressowany; jedynym zaakceptowanym findingiem jest `GHSA-qwww-vcr4-c8h2`.

Publikacyjne identyfikatory commit/PR/run oraz końcowe statusy są raportowane w PR i końcowym handoffie po remote gate.

## Z. Remaining split-brain

- Dashboard, Cases, Reports, Export i Requests nadal konsumują `ReleaseCompatibilityRecord`; jest on hydratowany wyłącznie z PostgreSQL i nie ma write-back.
- Compatibility używa historycznych nazw `identityChecked`/`holdCleared` jako derived read booleans dla starych konsumentów; źródłem są current explicit checks + current Passenger hold, nie mutowalne kolumny.
- `matchingRecordId` pozostaje opcjonalnym linkiem projection, ale safety decisions korzystają wyłącznie z `MatchDecision`.

Nie istnieje production dual-write ani drugi Release command implementation.

## AA. Risks

1. React Router `GHSA-qwww-vcr4-c8h2` pozostaje jedynym znanym dependency advisory i nie jest suppressowany.
2. Read-only compatibility booleans zachowują stare nazwy do czasu migracji Dashboard/Cases/Reports/Export/Requests.
3. Formalna separation-of-duties checker != authorizer nie jest jeszcze zdefiniowana przez policy; actorzy są zapisani oddzielnie, ale system nie wymusza różności.
4. Globalny outbox nie istnieje; audit/timeline są atomowe lokalnie, integracje zewnętrzne pozostają osobnym gapem.
5. Terminal correction/amendment ma świadomie brak publicznego workflow; wymagane jest anulowanie przed completion albo nowa kontrolowana akcja po decyzji produktowej.
6. Evidence reference jest tekstową bezpieczną referencją/typem, nie integracją object storage.
7. Compatibility hydration jest paged wewnętrznie, ale legacy consumers nadal pracują na projection arrays do czasu ich własnych slice migrations.
8. Queue została zweryfikowana na 1000 rekordach; znacznie większa skala wymaga obserwacji query plans/indeksów.

## AB. Next decision

```text
READY FOR REQUESTS SLICE
```

Stage 6 nie rozpoczyna migracji Requests.
