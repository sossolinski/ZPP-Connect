# Foundation Stage 8 — Operational Assignments Report

## A. Stage 7/main verification

Prace rozpoczęto z czystego `origin/main` na commitcie `7712553eded5757296fa13798b5a6ac54a407430` (`Merge pull request #4 ... foundation-stage-7-requests`). Finalny commit Stage 7 `735a34e` jest przodkiem tego commita. Gałąź Stage 8 to `agent/foundation-stage-8-assignments`; przed implementacją worktree był czysty.

## B. IncidentAssignment vs AssignmentTask boundary

`IncidentAssignment` pozostaje security grantem: decyduje, czy User ma bieżący dostęp do Incident. `AssignmentTask` jest operacyjnym zobowiązaniem i przechowuje odpowiedzialność za wykonanie pracy. `AssignmentTask.assignedUserId` wskazuje na `User`, nigdy na `IncidentAssignment`; revoke nie usuwa ani nie zmienia historycznego assignee. Ownership nie przyznaje dostępu, a każda operacja nadal wymaga permission i aktywnego `IncidentAssignment` aktora.

## C. Current Assignments contract

Przed Stage 8 istniały dwa write workflows: generic memory routes w `demo-router.ts` i osobne Prisma routes w `routes/index.ts`. Lista była fetch-all; claim używał `/assign-to-me`, lifecycle używał generic `/status`, a memory `groupId` tworzył pozór group ABAC, którego schema PostgreSQL nie przechowywała. Audit/timeline nie były atomowe z mutacją. Po Stage 8 jedynym command contractem jest modularny Assignment router/service/repository; stary `GET /assignments` pozostał wyłącznie deprecated/read-only projection.

## D. Field classification

- Identity/scope: `id`, `operationalId`, `sessionId`/`incidentId`.
- Task facts: `title`, `details`, `caseId`, `linkedRecord`.
- Operational planning: `priority`, `relatedFunction`, `dueAt`; `overdue` jest pochodną czasu, statusu i due date.
- Ownership: `assignedUserId`; nazwy są wyłącznie projections. `legacyAssigneeLabel` zachowuje nierozwiązany tekst.
- Controlled lifecycle: `status`, completed/cancelled actor, time i note/reason.
- Provenance/technical: `version`, created/updated actor/time, `AssignmentOperation`, request ID.
- Legacy/ambiguous: `legacyImported`, `legacyMetadata`, `legacyAssigneeLabel`.

Generic PATCH może zmieniać wyłącznie fakty i planning; nie przyjmuje statusu, assignee ani terminal provenance.

## E. Target architecture

Jedna ścieżka production to `AssignmentRouter → AssignmentService → AssignmentRepository`. PostgreSQL repository jest source of truth; memory repository implementuje ten sam kontrakt wyłącznie jako test double. `IncidentAccessService` tworzy `IncidentContext` przed read/write, a repository ponownie sprawdza writable incident, permission i aktywny grant aktora wewnątrz transakcji. Dashboard, Active Event, Reports, Export i Readiness mogą czytać kompatybilny projection bez write-back.

## F. Data model

`AssignmentTask` otrzymał stabilny `ASN-YYYY-NNNNNN`, `version`, canonical `assignedUserId`, honest legacy fields, terminal actor/time/reason/note oraz FK do User. `AssignmentOperation` rejestruje incident-scoped `operationId`, fingerprint, command, result version i request ID. PostgreSQL ma CHECK dla version/status/priority/terminal provenance, indeksy queue oraz trigger wymuszający ten sam Incident dla operation i task. FK assignee/terminal actor używa RESTRICT, dzięki czemu hard delete User nie niszczy historii.

## G. Ownership semantics

Nowy task zawsze zaczyna jako `Open` i unassigned. Stable User ID jest autorytatywnym ownerem; display name nie jest inputem write ani kluczem. Request owner i Assignment assignee są niezależne — real PostgreSQL test zmienia Assignment ownership i potwierdza niezmieniony `Request.ownerUserId`. Nie istnieje unassign/reopen, ponieważ obecny kontrakt ich nie wspierał; błędne zadanie kończy się kontrolowanym `Cancelled` z reason.

## H. Assignee eligibility

Bieżący kandydat musi jednocześnie być aktywnym User, mieć aktywny `IncidentAssignment` do tego Incident i efektywne `assignment:read`. Backend udostępnia incident-scoped search/paging bez całego katalogu User. User bez permission lub bez aktywnego grantu nie może otrzymać current task. Sam fakt bycia assignee nie podnosi uprawnień.

## I. Group/function semantics

Usunięto `groupId` z Assignment authorization. Nie był trwałym polem AssignmentTask w PostgreSQL i nie może tworzyć security boundary. `relatedFunction` pozostaje zwykłym incident-scoped metadata/filter; nie przyznaje dostępu. Stage 8 nie tworzy dependency na memory Groups, Members, Roster ani Availability.

## J. Status FSM

Zachowany, jawny FSM:

```text
Open --start--> In Progress --escalate--> Escalated --resume--> In Progress
In Progress --complete--> Completed
Open | In Progress | Escalated --cancel--> Cancelled
```

Start/escalate/resume/complete/cancel są osobnymi endpoints. `Completed` i `Cancelled` są terminalne i read-only. Nie ma generic `/status`, reopen, unassign ani hard delete.

## K. Priority / due / overdue

Priority zachowuje istniejący katalog `Normal | Urgent | Critical` i jest wersjonowanym planning field w ograniczonym PATCH. `dueAt` jest nullable planning field; `overdue` nie jest zapisywane i jest wyliczane dla nieterminalnego taska. Queue filtruje due/today/overdue/none i sortuje server-side.

## L. Claim / assign / reassign

Claim jest jawną akcją self-service dla `Open` + naprawdę unassigned taska. Assign wymaga `assignment:assign`; reassign wymaga istniejącego ownera i handover reason. Wszystkie trzy sprawdzają wersję i eligibility w serializable transaction. Równoległy claim oraz manager assign-vs-claim mają dokładnie jednego zwycięzcę; concurrent reassign daje jedną zmianę i jeden `409` dla stale writer.

## M. Revoked assignee semantics

Revoke `IncidentAssignment` nie modyfikuje `AssignmentTask.assignedUserId`. Context zwraca `assigneeEligible: false` oraz komunikat „Assigned user no longer has access to this incident. Reassignment is required.” Revoked actor dostaje `404` przy następnym request, manager widzi historycznego ownera i może wykonać audited reassign albo cancel. UI nie pokazuje start/complete dla stale assignee.

## N. API contract

- `GET /assignments/queue`, `GET /assignments/assignees`, `GET /assignments/:id`
- `POST /assignments`, `PATCH /assignments/:id`
- `POST /assignments/:id/assign`, `/claim`, `/reassign`
- `POST /assignments/:id/start`, `/escalate`, `/resume`, `/complete`, `/cancel`
- `GET /assignments` — deprecated/read-only compatibility projection

Queue obsługuje limit/offset, search, status, priority, assignee, unassigned, mine, due/today/overdue/none, relatedFunction i sort. Strict schemas odrzucają controlled fields w create/PATCH.

## O. IncidentContext / security

Authentication → `assignment:*` permission → aktywny `IncidentAssignment` → `IncidentContext` → service/repository obowiązuje dla każdego endpointu. REAL, EXERCISE i TRAINING są rozdzielone przez incident ID; podanie task ID z innym Incident zwraca `404`. Closed/Archived pozwala na historyczny read, ale każdy write zwraca `409`. `caseId`, `linkedRecord` i `relatedFunction` nie są security scope.

## P. Permissions

Zachowano istniejące singular permissions: `assignment:read`, `assignment:create`, `assignment:update`, `assignment:assign`. Create wymaga create; facts/planning i self lifecycle wymagają update; manager ownership wymaga assign. Complete/cancel nadal wymagają update oraz bycia current assignee albo managerem. UI nie używa hard-coded roli/grupy do autoryzacji managera; backend jest ostatecznym enforcementem.

## Q. Concurrency

Każdy write używa `expectedVersion` poza create, który powstaje z version 1. Conditional `updateMany`, status/owner predicates i serializable transaction nie auto-retry controlled decisions. Real PostgreSQL testy pokrywają claim-vs-claim, assign-vs-claim, reassign-vs-reassign oraz complete-vs-cancel; w każdym wyścigu występuje dokładnie jeden success i jeden `409`.

## R. Idempotency

Create, claim, assign, reassign, complete i cancel wymagają UUID `operationId`. Unique `(incidentId, operationId)` oraz fingerprint bronią przed podwójną logical action; identyczny retry zwraca ten sam task z `idempotent: true`, a reuse dla innych danych/command zwraca `409`. UI zachowuje operation ID po timeout/failure i usuwa go dopiero po sukcesie. Testy potwierdzają pojedynczy audit dla retry claim, complete i cancel.

## S. Audit / timeline

Mutacja, `AssignmentOperation` (gdy wymagany), AuditLog i CaseTimelineEvent powstają w jednej transakcji. Provenance obejmuje actor, incident, task UUID/ASN, command, before/after status/assignee/priority, reason/note, expected/result version, request ID i server timestamp. Nazwy assignee są snapshots w audit metadata, ale canonical source pozostaje User ID. Zwykły facts/planning update nie zaśmieca timeline.

## T. Notifications boundary

Notification jest wykonywane dopiero po committed transaction i jest best-effort. Router izoluje wyjątek; symulowana awaria notification pozostawia task, audit i timeline w PostgreSQL. Nie dodano outboxu ani notification persistence — to jawny przyszły gap, który nie wpływa na Assignment correctness.

## U. Legacy backfill

Migracja zachowuje każdy stary task, version 1 i timestamps. Stable `assignedUserId` jest zachowany. Text-only owner przechodzi do User FK tylko przy dokładnie jednym aktywnym User o identycznym display name; niejednoznaczny/brakujący owner pozostaje `legacyAssigneeLabel`. Nieznane status/priority są normalizowane z oryginałem w metadata. Historyczny terminal time używa zachowanego `updatedAt` i jawnego flagowania; actor ani transition/operation history nie są fabrykowane.

Dokładny CI rehearsal: 4 legacy assignments; 1 stable User ID retained; 1 text-only owner resolved; 1 text-only owner unresolved; 1 record bez ownera; 1 historyczny terminal timestamp; 1 invalid status/priority anomaly; 0 legacy group references; 0 synthetic AssignmentOperations. Fixture nie zawiera stale incident-eligibility anomaly; runtime wykrywa ją dynamicznie i pokazuje warning.

## V. Frontend / UX

`AssignmentsPage` używa `/assignments/queue` z page size 100 i server filters zamiast fetch-all. Queue pokazuje ASN, title, status, priority, assignee, function, due/overdue i updated time; ma My/Unassigned/Overdue, search, sort i paging. Dedykowane dialogs obsługują create/edit, assign/reassign, escalation/cancellation reason i terminal confirmation. `409` jest jawny bez automatycznego retry; stale assignee ma czerwone ostrzeżenie. Terminal detail pokazuje actor/time/reason. Zachowano `DialogSurface`, focus management, keyboard behavior, text status i ErrorSummary.

## W. Scale

Real PostgreSQL suite tworzy 1000 AssignmentTasks w jednym Incident. Potwierdza stabilne paging/offset, search po ASN/title, status, priority, assigned user, unassigned, My Assignments, overdue, relatedFunction i sort. Frontend pobiera maksymalnie jedną stronę 100 rekordów, a API ogranicza stronę do 200. Indeksy odpowiadają status/update, assignee/status, priority/status, dueAt i relatedFunction.

## X. Legacy removed + LOC

Usunięto wszystkie aktywne production Assignment writes z generic routera, starego Prisma routera i legacy validation schemas. `assignmentTask.create/updateMany` występuje produkcyjnie tylko w nowym Prisma repository; `upsert` pozostaje wyłącznie w seed. Memory array jest test double/read-only compatibility cache w trybie PostgreSQL, bez write-back. `/assign-to-me` i `/status` nie istnieją.

```text
demo-router.ts before:        4381
demo-router.ts after:         4081

routes/index.ts before:       1691
routes/index.ts after:        1332

AssignmentsPage.tsx before:   1067
AssignmentsPage.tsx after:    1212
```

## Y. Tests

- Prisma format/generate/validate: PASS.
- Typecheck: PASS.
- API unit/memory: PASS — 96/96 (PostgreSQL suites są celowo skipped bez `TEST_DATABASE_URL`).
- Fresh PostgreSQL 16 migration + seed: PASS.
- Stage 1–8 real PostgreSQL: PASS — 53/53, zero skipped.
- Exact legacy backfill rehearsal: PASS.
- Build: PASS; wyłącznie istniejące ostrzeżenie Vite o rozmiarze chunku.
- Browser: PASS — 61/61, w tym create, manager assign, self-claim, reassign, lifecycle/complete, 409 stale claim, revoked-assignee warning, candidate exclusion, closed Incident, role/access i mobile/focus parity.
- Production Dependency Audit: PASS lokalnie — zero findings.

## Z. CI

Branch: `agent/foundation-stage-8-assignments`. Commit, Draft PR i remote run IDs zostaną wpisane po publikacji finalnego local-gate commita. Workflow `Foundation PostgreSQL Gate` obejmuje fresh migration, seed, startup, Stage 1–8 (53 real PostgreSQL tests, zero skipped) i dokładny backfill rehearsal. Quality obejmuje Typecheck, Unit, Build i Browser. Dependency Audit pozostaje niesuppressowany; lokalny run ma zero findings, a `GHSA-qwww-vcr4-c8h2` jest jedynym advisory dopuszczonym przez brief, gdyby runner nadal je raportował.

## AA. Remaining split-brain

- Dashboard, Active Event, Reports, Export i Readiness nadal konsumują read-only `AssignmentCompatibilityRecord[]`; źródłem hydratacji jest PostgreSQL i nie ma write-back.
- Notifications są nadal memory/derived bez durable outbox; Assignment commit jest od nich niezależny.
- Member profiles i Groups są nadal in-memory repositories, mimo że stanowią źródło operacyjnej struktury zespołów dla Rostering/Training/Documents/Readiness.
- Rostering i Availability nadal zapisują do pamięci i zależą od memory Member Directory.
- Training, Documents, Readiness i Briefings pozostają osobnymi niemigrowanymi obszarami.
- `caseId` i `linkedRecord` pozostają tekstowymi metadata bez relacyjnego Case modelu.

Nie istnieje drugi production Assignment command implementation ani production Assignment dual-write.

## AB. Risks

1. Read-only compatibility arrays nadal utrzymują starych konsumentów do czasu ich osobnych migracji.
2. Brak durable outbox oznacza, że zewnętrzne notifications mogą wymagać późniejszego retry/reconciliation, choć nie wpływają na commit taska.
3. Historyczny terminal time używa `updatedAt`, bo legacy model nie miał osobnego czasu decyzji; metadata ujawnia ograniczenie.
4. Exact display-name backfill jest celowo konserwatywny i może pozostawić ręczny reconciliation dla niejednoznacznych labels.
5. Queue zweryfikowano na 1000 rekordach; większa skala może wymagać obserwacji planów i dedykowanego indeksu tekstowego.
6. `caseId`/`linkedRecord` nie zapewniają integralności referencyjnej i pozostają poza authorization scope.
7. User hard delete jest blokowany przez historyczne Assignment FK; lifecycle powinien nadal używać suspend/archive zamiast delete.

## AC. Next decision

```text
NOT READY
```

Jedynym otwartym gate’em jest pełny finalny local rerun oraz rzeczywisty remote GitHub CI dla finalnego SHA. Po ich przejściu raport zostanie zmieniony na `READY FOR NEXT FOUNDATION SLICE` i wskaże dokładnie jeden kolejny pionowy slice. Żaden kolejny slice nie został rozpoczęty.
