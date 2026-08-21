# Foundation Stage 13 — Notifications Persistence + Delivery Integrity Report

## A. Stage 12 merge verification

- PR #9 miał aktualny finalny HEAD `88634cbc3c64996da3ddafc1fa31d2973022f275`, był otwarty, mergeable/clean i posiadał zielone gates dla dokładnego SHA: fresh migration/seed/startup, Stage 1–12 PostgreSQL `121/121` zero skipped, exact legacy rehearsal, Typecheck, Unit `96/96`, Build, Browser `70/70` i Production Dependency Audit.
- PR #9 oznaczono Ready i scalono standardowym merge commitem `73034c4a89f6f0f3ad918b336ddf684cdfc52705` bez force push.
- `88634cb…` jest przodkiem `origin/main`; Stage 13 rozpoczęto na `agent/foundation-stage-13-notifications` z `73034c4…` i czystego worktree.

## B. Current Notification contract

| Powierzchnia | Kontrakt przed Stage 13 | Authority po Stage 13 |
| --- | --- | --- |
| List/item/counts | memory `Map`; GET uruchamiał source reconciliation i seed | read-only PostgreSQL queries |
| Read/unread | procesowa pamięć | trwałe `readAt` |
| Active/resolved | memory mutation podczas GET | trwałe `resolvedAt`/`resolutionReason`, zmieniane przez projector/source lifecycle |
| Deduplication | lokalny key w procesie | unique `(recipientUserId, deduplicationKey)` |
| Delivery | callback po commandzie albo reconciliation-on-read | transactional outbox + idempotent dispatcher |
| Recipient/scope | demo arrays i role snapshots | PostgreSQL User/Role/MemberProfile/IncidentAssignment |

Memory implementation pozostaje adapterem testowym. W production PostgreSQL nie jest konstruowany i nie obsługuje żadnej trasy Notifications.

## C. Event Notification matrix

| Event | Recipient | Intent durability | Dedupe |
| --- | --- | --- | --- |
| Session closed | aktywni użytkownicy z `session:read` i current IncidentAssignment | ten sam transaction co close | outbox ID per recipient |
| Assignment assigned/claimed/reassigned | wskazany aktywny User z current incident access | ten sam transaction co ownership command | outbox ID |
| Assignment cancelled | aktualny assignee | ten sam transaction co cancel | outbox ID |
| Assignment escalated | aktualny assignee | ten sam transaction co escalation | outbox ID; condition dodatkowo reopen/reset unread |
| Roster published | User po exact MemberProfile link | ten sam transaction co publish | outbox ID |
| Training assigned | User po exact MemberProfile link | ten sam transaction co assignment | outbox ID |
| Document Requirement created/updated | current exact Member/Group/Role targets | ten sam transaction co Requirement | outbox ID |
| Briefing published | current incident users z `briefing:read` | best-effort po memory Briefing commit | briefing/revision/user |
| Admin/Identity change | exact target User | best-effort po route-level memory command | access source/user |

Briefings oraz Admin/Identity są jawnie compatibility exceptions: event Notification jest durable, lecz source command i Notification nie współdzielą PostgreSQL transaction.

## D. Condition Notification matrix

| Condition | Active source predicate | Resolution |
| --- | --- | --- |
| Assignment | assigned User, status nie `Completed/Cancelled` | source przestaje należeć do pełnego bounded scan |
| Roster confirmation | Published shift, linked active User | confirm/decline/cancel/complete albo utrata predicate |
| Training | authoritative Training evaluator: overdue lub Expired | evaluator nie zwraca już actionable record |
| Document | authoritative Documents evaluator: required i nie acknowledged; overdue wpływa na severity | ACK, Requirement end, Version withdraw/supersede lub inna utrata applicability |

Projector nie tworzy osobnej karty dla każdego odczytu. Jeden deterministic condition key reprezentuje jeden recipient/source/condition.

## E. Recipient model

- Direct User events wymagają istniejącego aktywnego User.
- Roster i Training rozwiązują `MemberProfile.linkedUserId`; brak linku nie tworzy fikcyjnego użytkownika. Aktywny unlinked Member pozostawia outbox jako pending/waiting, a Archived kończy delivery z zerem recipients.
- Document Requirement rozwiązuje exact Member, durable GroupMembership albo jawny Role target. Group-specific delivery dodatkowo wymaga current IncidentAssignment.
- Permission broadcast czyta durable UserRole → Role permissions, a nie memory role snapshot.

## F. Scope / visibility model

Inbox jest zawsze własny: klient nie podaje recipienta. Notification bez session jest widoczna aktywnemu recipientowi. Session-scoped Notification wymaga current active IncidentAssignment; System Admin ma jawny global override. Revocation natychmiast usuwa rekord z list/get/counts i blokuje read/unread. Nieaktywne konto nie widzi inboxu.

## G. Event vs Condition semantics

`EVENT` jest immutable historycznym faktem; wolno zmienić tylko `readAt` i techniczne `updatedAt`. Trigger DB blokuje zmianę recipienta, treści, source snapshotu, action, metadata, resolve i version. `CONDITION` jest current-state projection, może być updated, resolved i reopened z rosnącym `version`.

## H. Read vs Resolve semantics

`readAt` oraz `resolvedAt` są niezależne. Resolve nie oznacza automatycznie read, a mark read/unread nie zmienia active/resolved. Dlatego wspierane są Active+Read, Active+Unread, Resolved+Read i Resolved+Unread.

## I. Condition escalation decision

Zwykły refresh condition zachowuje `readAt`. Reopen po wcześniejszym resolve i rzeczywista Assignment escalation ustawiają `readAt=null`, ponieważ powstała nowa potrzeba uwagi. Policy jest jawna przez `resetUnread`, a atomic UPSERT rozstrzyga ją razem z reopen/version increment.

## J. PostgreSQL Notification model

`Notification` przechowuje recipient, mode/kind/severity/category, bezpieczne title/message, optional session/source snapshots, condition/action, allowlisted metadata, read/resolve timestamps, version i timestamps. CHECK constraints egzekwują enum-like values, shape EVENT/CONDITION, dodatnią version i względny action path. User oraz Session używają `ON DELETE RESTRICT`, aby zachować historię.

## K. Deduplication

- Event: `event:outbox:<outboxId>` per recipient; retry po insert-before-ack zwraca istniejący row.
- Condition: `condition:<sourceType>:<sourceId>:<conditionType>:<recipientId>`.
- DB unique `(recipientUserId, deduplicationKey)` jest ostatecznym concurrency guardem.
- Domain time nie jest event identity; aggregate version/operation ID identyfikuje outbox intent.

## L. Transactional outbox

`NotificationOutbox` przechowuje allowlisted event type, aggregate identity/version, optional direct recipient/session, minimalny PII-safe payload, status, attempts, availability, lease, delivery/failure timestamps i bounded error classification. Durable Session, Assignment, Rostering, Training i Document commands zapisują source state i intent w tej samej Prisma transaction. Nie ma generic event busa ani osobnej infrastruktury messaging.

## M. Dispatcher

Dispatcher claimuje bounded batch przez `FOR UPDATE SKIP LOCKED`, rozwiązuje recipients z PostgreSQL, materializuje immutable Events i dopiero potem oznacza intent delivered. Dwie instancje mogą pracować równolegle. Brak recipienta z powodu archived/inactive state kończy zdarzenie bez fake row; aktywny, lecz jeszcze unlinked Member jest retryable waiting.

## N. Retry / lease / failure

Claim inkrementuje attempt i ustawia worker/lease. Expired PROCESSING lease jest odzyskiwany. Transient failure wraca do PENDING z exponential backoff ograniczonym do 5 minut; po `maxAttempts` przechodzi do trwałego FAILED. `lastError` zawiera wyłącznie `name:code`, bez payloadu/stack trace. Waiting na identity link nie zużywa attempt budgetu.

## O. Time-driven condition projector

Projector skanuje Assignment, Roster i linked MemberProfile w bounded keyset pages. Training i Documents są oceniane przez ich Foundation repositories jako authoritative read projections. Resolve-missing uruchamia się tylko po pełnym scan danego scope; osiągnięcie `maxRows` nie może masowo resolve'ować niewidzianych keys.

## P. Clock

Production używa `new Date()` przez clock adaptery. Dispatcher, projector, retry oraz read/resolve przyjmują wstrzykiwany clock w testach. `occurredAt` pochodzi z committed source state, a nie służy jako dedupe identity.

## Q. Session producer

Close zapisuje status/provenance, Audit/Timeline i `SESSION_CLOSED` intent w jednym transaction. Notes nie trafiają do outbox ani Notification copy.

## R. Assignment producer

Assign/claim/reassign, cancel oraz escalate zapisują odpowiednie intents atomowo z Assignment i operation log. Payload używa tylko operational ID, command i time; swobodny title/details/reason nie opuszcza domeny. Complete/cancel/reassign są odzwierciedlane przez projector w condition lifecycle.

## S. Rostering producer

Publish zapisuje `ROSTER_PUBLISHED` razem z versioned lifecycle command. Recipient pochodzi z current MemberProfile link i current incident access. Immediate cancel zachowuje historyczny publish event, ale projector nie utrzymuje confirmation condition.

## T. Training producer

Każdy faktycznie utworzony MemberTrainingRecord dostaje intent w tej samej assign transaction; skipped active duplicates nie dostają eventu. Link/archive jest ponownie oceniany w dispatcherze. Overdue/Expired pozostaje time-driven condition z Training evaluator.

## U. Documents producer

Requirement create/update zapisuje intent atomowo. Delivery jest requirement-driven, nie stanowi broadcastu każdej publikacji. Current target oraz Published/active source są ponownie sprawdzane przed delivery. ACK/end/withdraw/supersede rozwiązuje condition przez authoritative Documents evaluator.

## V. Briefings compatibility boundary

Briefing/Active Event source nadal jest memory authority. Po committed publish callback zapisuje durable event rows dla current incident recipients, lecz nie istnieje wspólna transaction/outbox guarantee. Failure jest best-effort i jawnie pozostaje remaining split-brain; Stage 13 nie udaje delivery guarantee dla tego źródła.

## W. Admin/Identity compatibility boundary

User/Role odczyty istnieją w PostgreSQL, ale command lifecycle, invitations, external identities, permission overrides i część access policy nadal ma route-level/memory authority. Targeted access Notification jest durable best-effort po commandzie, bez transactional coupling. To ograniczenie wpływa na next-slice decision.

## X. Security / PII

API nie ma publicznego create/resolve endpointu. Policy przepuszcza wyłącznie wewnętrzne action routes, ograniczone długości, kontrolowane copy oraz allowlisted scalar metadata. Email/phone/credential/medical/identity patterns są odrzucane. Outbox filtruje event-specific keys; assignment title, roster function, course/document title, notes, raw rows, JWT, request i stack trace nie są przechowywane.

## Y. API

`GET /notifications`, `/counts`, `/:id`, POST `/:id/read`, `/:id/unread` i `/read-all` działają asynchronicznie na PostgreSQL. List obsługuje unread, kind, category, severity, session, source, active/resolved, bounded limit/offset i deterministic sort. Delivery health jest ukryte jako 404 bez `admin:manage`.

## Z. Counts / paging

Counts składa się z dziewięciu server-side `COUNT` queries nad pełnym visible scope: total, unread, active, resolved, actionRequired, actionRequiredUnread, updates, updatesUnread i criticalUnread. Nie ładuje pierwszych 200 rows. List ma limit 1–200; mark-all bez IDs aktualizuje cały visible scope, a explicit ID set do 5000 jest walidowany atomowo.

## AA. Read/unread

Read/unread jest trwałe, restart-safe i idempotent. Single/bulk mutations ponownie egzekwują recipient oraz current incident visibility. Invalid albo foreign ID w explicit bulk powoduje 404 i zero partial update. Read-all vs nowy event ma poprawną serializowalną kolejność: nowy row istnieje dokładnie raz, a read state zależy wyłącznie od kolejności commitów.

## AB. Frontend

NotificationCenter używa trwałych API mutations, po mark-all odświeża bounded listę i counts, zachowuje read/unread po reload, otwiera tylko dozwolone destination i zamyka się Escape. Stabilny browser test nie zależy od pozycji elementu, która poprawnie zmienia się po unread-first sort. Dodano pełną kategorię Admin.

## AC. Startup / shutdown

Po listen runtime uruchamia natychmiast bounded dispatch i projection, potem niepokrywające się intervals. Shutdown najpierw zatrzymuje nowe cycles, czeka na in-flight work maksymalnie 10 sekund, czyści timers, loguje timeout i dopiero pozwala zamknąć server/Prisma. Unit test pokrywa overlap, timer cleanup i bounded stop.

## AD. Backfill / seed

Migration nie fabrykuje historycznych Notifications, recipients, readAt ani attempts. Prisma seed tworzy jawnie dokładnie trzy fixtures z `provenance=prisma-seed`: coordinator Session Event, admin access Event i volunteer Training Condition. Memory sample są materializowane tylko przy construction test adaptera, nigdy podczas GET i nigdy w production.

## AE. Concurrency

Stage 13 PostgreSQL suite pokrywa: dual dispatcher/event dedupe, concurrent condition UPSERT, resolve/reopen, condition/read race, read/unread race, read-all/new event, access revoke/list/get, dual outbox claim, expired lease, insert-before-delivered crash, commit-before-dispatch restart, Assignment assign→cancel i reassign, Roster publish→cancel, Training assign→archive/link, Document Requirement create→end, ACK→project oraz withdraw→project. DB unique, row locks, atomic UPSERT i visibility recheck są ostatecznymi guards.

## AF. Scale

Test tworzy 1005 Notifications dla jednego recipienta plus innego recipienta, sprawdza counts, page offset 800 i mark-all bez hidden cap. Osobny projector scan tworzy i resolve'uje 1005 Assignment conditions w batchach po 113. Production defaults: dispatch 100, projection page 200, max scan 10000; wszystkie są walidowanymi dodatnimi integer env values.

## AG. Observability

Structured dispatcher logs zawierają outbox ID, event type, attempt, result, recipient count, duration i bezpieczną failure classification. Admin health raportuje pending, failed i oldest pending age. Nie loguje payloadu ani Notification content. Pełny monitoring/alerting pozostaje poza zakresem.

## AH. Legacy removed + LOC

| Plik | Przed | Po | Uwagi |
| --- | ---: | ---: | --- |
| `apps/api/src/notifications.ts` | 946 | 921 | wyłącznie memory/test adapter; usunięto production singleton/exporty |
| `apps/api/src/demo-router.ts` | 4201 | 4208 | persistent router wiring i jawne compatibility boundaries |
| `apps/api/src/routes/index.ts` | 1361 | 1330 | usunięto stare sync routes; dodano composition/runtime |
| `apps/api/src/app.ts` | 105 | 108 | repository injection |
| `apps/web/src/components/NotificationCenter.tsx` | 334 | 335 | durable read-all flow i Admin category |
| `apps/api/prisma/schema.prisma` | 1341 | 1409 | Notification + Outbox |
| `apps/api/src/modules/notifications/*` | 0 | 647 | policy, repository, service, router, dispatcher, projector, runtime i tests |

W production nie istnieje aktywny `defaultNotificationService`, `seedInitialEvents`-on-read ani `reconcileForUser` na API GET. Legacy memory reconciliation pozostaje osiągalne tylko w automatycznych testach uruchamianych z `PERSISTENCE_MODE=memory`.

## AI. PostgreSQL tests

- Nowy Stage 13 suite: **15/15 PASS** w PostgreSQL CI (`foundation-stage13-postgres.integration.test.ts`, 3.225 s).
- Local PostgreSQL/Docker runtime: **niedostępny** (`docker: command not found`), dlatego nie deklarujemy lokalnego PostgreSQL PASS.
- Fresh PostgreSQL 16 migration (wszystkie 16 migracji, w tym `20260820170000_notifications_foundation`), exact Prisma seed i production startup/health: **PASS**.
- Stage 1–13 PostgreSQL: **136/136 PASS, 0 skipped** w 14 plikach; exact legacy migration/backfill rehearsal: **PASS**.

## AJ. Browser tests

- Nowy NotificationCenter scenario: read, reload persistence semantics adaptera, unread, read-all, action link i Escape — **PASS**.
- Pełny Browser gate: **71/71 PASS**.
- API-level Stage 13 PostgreSQL tests pokrywają >200, active/resolved, event/condition, isolation, revoke, dedupe, escalation i source resolution.

## AK. CI

Remote gates dla implementacyjnego SHA `74c2cbfefdd2ce82bf26f2c79888998d2c5ee42c` przeszły dwukrotnie, dla zdarzeń `push` i `pull_request` (runs `32420608988` oraz `32420612033`).

| Gate | Wynik |
| --- | --- |
| Typecheck | PASS |
| Unit | PASS — 99/99; 136 PostgreSQL tests skipped lokalnie bez DB |
| Build | PASS; istniejący Vite chunk-size warning |
| Browser | PASS — 71/71 |
| Production runtime Dependency Audit | PASS — zero findings |
| `git diff --check` | PASS |
| Fresh migration / exact seed / startup | PASS |
| Stage 1–13 PostgreSQL | PASS — 136/136, zero skipped; Stage 13 15/15 |
| Exact legacy rehearsal | PASS |
| Remote GitHub Actions exact implementation SHA | PASS — 6/6 checks across both CI triggers |

## AL. Remaining split-brain

| Kandydat | Active writes / authority po Stage 13 | Security/dependency centrality | Ocena |
| --- | --- | --- | --- |
| Briefings / Active Event | memory publish/content/session view; Notifications tylko best-effort | średnia; ważny incident context | realny, węższy slice |
| Imports | memory staging/confirmation; durable target records | wysoka data-integrity, ale izolowany ingest workflow | po identity albo Briefings |
| Admin / Identity | memory user lifecycle, invitations, external identities, access overrides i role commands obok durable User/Role reads | najwyższa; zasila auth, recipients, permissions i incident visibility | najwyższy kolejny kandydat |
| Exports / Reports | głównie derived reads, część mieszanych źródeł | niższa write authority | później |
| Readiness | computed service nad trwałymi głównymi domenami | wysoka dependency, brak własnego primary writer | nie następny write-owning slice |

## AM. Risks — max 10

1. Briefing i Admin/Identity events są durable, lecz ich source commands nie mają transactional outbox guarantee.
2. Memory test adapter może semantycznie odjechać od PostgreSQL contract; production go nie konstruuje.
3. Member bez linked User może pozostawić waiting outbox do czasu link/archive; health endpoint musi być monitorowany.
4. `maxRows=10000` chroni worker, ale przy większym backlogu pełne resolve poczeka na kolejny kompletny scan.
5. Polling nie zapewnia natychmiastowości; domyślne opóźnienia to 5 s events i 60 s conditions.
6. FAILED delivery wymaga operacyjnej reakcji; Stage 13 dostarcza diagnostykę, nie pełny alerting stack.
7. Exact role-target mappings dla Documents wymagają utrzymania wspólnie z Admin/Identity policy.
8. Event retention/archival policy nie została zaprojektowana; schema zachowuje historię przez restrictive FKs.
9. Vite nadal raportuje istniejący warning dla głównego chunka >500 kB, bez wpływu na Stage 13 gate.

## AN. Next decision

**Rekomendowany dokładnie jeden następny vertical slice: Admin / Identity Persistence + Access Integrity.**

Admin/Identity ma najwięcej aktywnych memory writes o najwyższej security i dependency centrality: User lifecycle, role assignments, permission overrides, invitations oraz external identities wpływają bezpośrednio na auth, notification recipient resolution, System Admin override i incident visibility. Briefings są ważnym, ale węższym incident-content writerem; Imports dotyczą bardziej izolowanego ingest workflow; Reports i Readiness są przede wszystkim derived. Następny slice nie został rozpoczęty.

## Final verdict

```text
READY
```

Foundation Stage 13 spełnia lokalne i zdalne gates. Draft PR pozostaje niescalony do czasu jawnej decyzji review/merge.
