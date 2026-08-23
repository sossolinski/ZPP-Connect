# Foundation Stage 14 — Admin / Identity Persistence + Access Integrity Report

## A. Stage 13 merge verification

- PR #10 miał finalny HEAD `2d04a23edf4774122874af9b80d4146586b02372`, status OPEN/DRAFT/CLEAN/MERGEABLE i sześć zielonych checks dla dokładnego SHA.
- PR oznaczono Ready i scalono standardowym merge commitem `5038dfb3001d42b7f5b1eda2d00ae7142ab2bb58` bez force push.
- Stage 13 head jest przodkiem `origin/main`; Stage 14 rozpoczęto na `agent/foundation-stage-14-admin-identity` z czystego worktree.

## B. Current User contract

### Current User lifecycle matrix (audit przed implementacją)

| Endpoint / caller | Permission / scope | Current source and mutation | PostgreSQL mutation | Audit / notification | Version / concurrency | Stage 14 decision |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /admin/users` | `admin:manage`, global | `users.push` w `demo-router.ts` | brak | memory Audit z aktywnym incidentem; brak trwałej atomowości | memory duplicate check, brak locka | durable User create; normalized e-mail unique; global Audit `sessionId=null` |
| `PATCH /admin/users/:id` | `admin:manage`, global | memory metadata update | brak | memory Audit | `expectedVersion` tylko w procesie | SQL optimistic update + durable Audit |
| `POST .../activate` | `admin:manage`, global | Pending → Active | brak | memory Audit + compatibility Notification | memory version | trwały FSM command, operation id, Audit/outbox w transakcji |
| `POST .../suspend` | `admin:manage`, global | Active → Suspended | brak | memory Audit + compatibility Notification | self/last-admin check bez DB locka | natychmiast blokuje auth; serializowany last-admin guard |
| `POST .../archive` | `admin:manage`, global | non-Archived → Archived | brak | memory Audit | brak ochrony cross-process | trwały terminalny stan bez hard delete/cascade operacyjnych rekordów |
| `POST .../restore` | `admin:manage`, global | Suspended → Active; Archived → Pending | brak | memory Audit + Notification | memory version | trwały jawny FSM z provenance |
| `GET .../lifecycle-impact` | `admin:manage`, global | memory snapshot plus częściowo directory | read-only | brak | brak spójnego snapshotu | bounded durable projection |
| `POST .../authentication-policy` | `admin:manage`, global | memory field | brak | memory Audit + Notification | memory last-admin check | tylko runtime-supported methods; w production `SSO_ONLY` |
| `POST .../revoke-sessions` | `admin:manage`, global | 501 | brak | brak | n/a | pozostaje jawnie unsupported bez fałszywego sukcesu |

Canonical User przed Stage 14 istnieje w dwóch formach: Prisma `User` ma lowercase `active` i mało provenance, natomiast memory Admin używa `Pending/Active/Suspended/Archived`, `version`, lifecycle timestamps, employee ID i auth policy. Stage 14 ujednolica je w PostgreSQL.

## C. Current Role contract

### Current Role / role assignment matrix (audit przed implementacją)

| Endpoint / caller | Permission / scope | Current source and mutation | PostgreSQL mutation | Audit / notification | Version / concurrency | Stage 14 decision |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /admin/roles` | `admin:manage`, global | memory role catalog | brak | brak | n/a | paged durable catalog seeded from shared code authority |
| `POST /admin/roles` | `admin:manage`, global | `roles.push` | brak | memory Audit | process duplicate check | durable custom role; DB normalized-name unique; `admin:manage` forbidden |
| `PATCH /admin/roles/:id` | `admin:manage`, global | memory mutation | brak | memory Audit per capability delta | memory version | SQL version guard; protected definitions code-owned |
| `POST .../archive` | `admin:manage`, global | `role.status = Archived` | brak | memory Audit | nie sprawdza aktywnych assignmentów | block while any active global/group assignment exists |
| `POST .../role-assignments` | `admin:manage`, global/group | memory `userRoleAssignments.push`; optional directory role snapshot write | czasem destrukcyjny `replaceRoleScopes`, nie identity authority | memory Audit + Notification | process duplicate/last-admin checks | osobne durable global i group assignment histories, partial unique active constraints |
| `POST .../revoke` | `admin:manage`, global/group | memory status revoke; optional directory replacement | częściowa, niekanoniczna | memory Audit + Notification | memory version | transactional revoke + protected last-admin lock |
| legacy `PATCH .../roles` | `admin:manage`, global/group | bulk memory replacement | częściowa directory replacement | memory Audit | brak idempotency | usunięty z reachable production; UI używa command endpoints |

## D. Current assignment contract

- Prisma `UserRole` ma composite key `(userId, roleId)`, więc nie zachowuje pełnej historii ponownych nadań i miesza globalny marker z group representation.
- Prisma `GroupRoleAssignment` zachowuje status/provenance/version, ale nie ma DB partial unique dla aktywnego `(user, role, group)`.
- Memory `RoleAssignment` zachowuje historię revoked, lecz jest utracony po restarcie.
- `GroupRoleAssignment` nie może tworzyć `IncidentAssignment`; Stage 14 wymaga obu aktywnych faktów, aby group role wpłynęła na request scope.

## E. Current PermissionOverride contract

### Current PermissionOverride matrix (audit przed implementacją)

| Endpoint / caller | Permission / scope | Current source and mutation | PostgreSQL mutation | Audit / notification | Version / concurrency | Stage 14 decision |
| --- | --- | --- | --- | --- | --- | --- |
| `POST .../capability-overrides` | `admin:manage`, global | `permissionOverrides.push` | brak | memory Audit + Notification | brak duplicate/lock; memory version | durable GRANT/DENY, expiry, partial active uniqueness |
| `POST .../revoke` | `admin:manage`, global | memory `active=false` | brak | memory Audit + Notification | memory version | SQL optimistic revoke |
| `GET .../effective-access` | `admin:manage`, global | memory calculator | brak | brak | request clock implicit | ten sam durable EffectiveAccessService co middleware |

DENY ma pierwszeństwo nad role i GRANT. `admin:manage` nie może być nadany przez override ani custom role; DENY może ograniczać admina tylko z serializowanym last-admin guardem.

## F. Current Invitation contract

### Current Invitation matrix (audit przed implementacją)

| Endpoint / caller | Permission / scope | Current source and mutation | PostgreSQL mutation | Audit / notification | Version / concurrency | Stage 14 decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| list/detail GET | `admin:manage`, global | memory list; GET wywołuje `expireInvitationIfNeeded` i mutuje | brak | memory Audit przy derived expiry | brak | expiry wyłącznie derived w read projection; GET bez write |
| create | `admin:manage`, global | ręczny multi-array try/rollback: User + roles + invitation + optional member link | tylko optional member directory side effect | memory Audit + Notification | e-mail race niezamknięty | jedna DB transaction, unique constraints, Audit/outbox |
| regenerate | `admin:manage`, global | memory generation/token replacement | brak | memory Audit + Notification | memory generation/version | atomic version/generation command; stare generation bezpowrotnie invalid |
| revoke | `admin:manage`, global | memory status/reason | brak | memory Audit + Notification | memory version | durable optimistic command |
| local-accept | `admin:manage`, dev only | memory identity + invitation + activation | brak | memory Audit + Notification | process generation check | wyłącznie non-production; DB transaction i explicit LOCAL_DEV identity |

## G. Current ExternalIdentity contract

### Current External Identity / authentication matrix (audit przed implementacją)

| Operation | Current key/source | Current risk | Stage 14 decision |
| --- | --- | --- | --- |
| Entra login | verified JWT → e-mail → Prisma User | e-mail reuse może przejąć konto; brak trwałego bindingu | verified issuer/audience plus stable `(tenantId, objectId)` lub `(issuer, subject)` |
| Legacy first login | brak identity row | każdy login powtarza e-mail lookup | dokładnie jeden atomowy bind, tylko gdy e-mail jednoznaczny i identity nie jest już owned |
| Unknown token | e-mail match lub 401 | token z matching e-mail może wejść | bez auto-provision; unknown stable subject bez eligible legacy bind = 401 |
| E-mail change | memory User e-mail | external owner zmienia się po e-mailu | binding pozostaje przy User; e-mail jest tylko snapshot/legacy bridge |
| Disable identity | brak endpointu/modelu | nie da się trwale wyłączyć bindingu | durable disable provenance; brak rebindu do innego User |
| Dev login | memory approved IDs/sessions | inny access graph niż PostgreSQL | dev transport ephemeral, ale User/access facts z tego samego DB |

## H. Current authentication contract

### Current effective access consumer matrix (audit przed implementacją)

| Consumer | Current source | Gap | Stage 14 decision |
| --- | --- | --- | --- |
| `authenticate` | Prisma UserRole/Role/GroupRoleAssignment | bez ExternalIdentity/override; lowercase status; group bez IncidentAssignment | IdentityService + EffectiveAccessService per request |
| `requirePermission` | `req.user.permissions` | projection pochodzi z niepełnego grafu | projection wyłącznie z durable service |
| `scope-policy` | `req.user.roleAssignments` + route incident checks | group assignment może być oznaczony Active bez incident access | group role aktywna tylko z current IncidentAssignment |
| Admin list/detail | memory arrays | restart drift | durable paged repository |
| Notifications recipient resolution | PostgreSQL Role/Member/IncidentAssignment | Admin/Identity source exception | identity outbox w tej samej transaction; Notification nie jest authority |
| Member Directory admin writes | PostgreSQL directory + memory user snapshot | dual write | one transaction owned by Identity service |
| frontend `/auth/me` | memory w demo lub Prisma w auth.ts | różne role/permissions | jedna authenticated projection |

Production route registration montuje `demo-router`, a legacy `routes/index.ts` API router nie jest montowany. Stage 14 utrzymuje memory adapter wyłącznie dla testów, ale produkcyjny `postgres` branch nie może rejestrować reachowalnych memory Admin/Auth writers.

## I. Canonical account status

`Pending`, `Active`, `Suspended`, `Archived` jest jedynym kontraktem. Lowercase historyczne values zostają jawnie zmapowane migracją.

## J. User lifecycle

Komendy `activate`, `suspend`, `archive` i `restore` zapisują User, provenance, globalny Audit oraz intent `ACCESS_CHANGED` w jednej transakcji. Każda zmiana inkrementuje `version`; niedozwolone przejścia kończą się `409`. Stan jest odczytywany ponownie przy następnym requestcie, więc zawieszenie działa natychmiast.

## K. Suspend vs Archive policy

Suspend jest odwracalnym natychmiastowym zablokowaniem logowania i access projection. Archive jest terminalnym wyłączeniem konta; restore z Archive prowadzi do Pending i wymaga ponownej aktywacji. Żaden stan nie usuwa rekordów operacyjnych.

## L. User metadata / normalized email

`email`, `normalizedEmail`, `displayName`, `employeeId`, `department`, `organizationId`, policy i lifecycle provenance są trwałe. Trigger normalizuje e-mail przed unique constraint; wyścig dwóch wariantów case ma jednego zwycięzcę.

## M. Organization

Organization ma unikalny `normalizedKey`, canonical status, version i archive provenance. List/create/update/archive/restore są paged/versioned; archiwizacja jest blokowana, dopóki organizacja ma niezarchiwizowanych użytkowników. Organization status nie zmienia automatycznie auth policy użytkowników.

## N. Role model

Role są trwałym katalogiem o znormalizowanej nazwie, capability JSON, dozwolonych scope’ach, pool, flags `protected/custom/operationalRole`, statusie i version. Definicje bazowe pochodzą z shared code i seed/backfill.

## O. Protected roles

Role chronione mają code-owned identifier/capabilities i nie mogą być archiwizowane. Edycja presentation metadata nie może zmienić ich bezpieczeństwa.

## P. Custom roles

Custom role może używać tylko istniejącego katalogu capabilities i nigdy `admin:manage`. Nazwa jest unikalna po normalizacji. Archiwizacja wymaga braku aktywnych globalnych i grupowych przypisań.

## Q. Global role assignments

Global assignment jest durable `UserRole`, ma UUID/provenance oraz immutable `RoleAssignmentHistory`. Duplicate race zamyka DB unique; assign/revoke zapisują Audit, bump User version i access outbox.

## R. Group role assignments

Group assignment jest osobnym `GroupRoleAssignment` z group scope, status/version/revoke provenance i partial unique dla aktywnego `(user, role, group)`. Marker `UserRole` nie jest samodzielnym grantem grupowym.

## S. IncidentAssignment interaction

Efektywny group grant wymaga jednocześnie aktywnej grupy oraz aktywnego `IncidentAssignment` użytkownika do incidentu grupy. Sam membership ani GroupRoleAssignment nie daje incident access; test Stage 9 oczekuje `403` przed wejściem do zasobu.

## T. Permission overrides

`GRANT`/`DENY` mają durable provenance, optional expiry i revoke lifecycle. DENY wygrywa nad rolą oraz GRANT; wygasłe/revoked wpisy nie wpływają na projection. `admin:manage` nie może być nadany przez override.

## U. Last-admin invariant

Wszystkie operacje mogące usunąć efektywne `admin:manage` biorą wspólny PostgreSQL advisory transaction lock i liczą aktywnych adminów z aktualnego grafu. Łączny wyścig dwóch suspendów kończy się dokładnie jednym `200` i jednym `409`.

## V. Self-elevation safeguards

Zabronione są self-suspend, self-archive, self-restore/activate oraz self-assignment System Admin. Nie można usunąć własnego System Admin ani stworzyć custom/admin override zapewniającego eskalację.

## W. MemberProfile linking

`MemberProfile.linkedUserId` jest nullable i unique. Link/unlink jest trwały, audytowany, chroniony przed podwójnym ownership i nie nadaje żadnego permission ani incident access.

## X. Authentication policy

Production capability matrix ma tylko `SSO_ONLY` / `MICROSOFT_SSO`. Password auth, reset i password invitation nie są reklamowane ani implementowane. Unsupported revoke-sessions zwraca jawne `501`, nie fałszywy sukces.

## Y. Entra stable identity binding

`ExternalIdentity` wiąże Entra przez unique `(providerType, tenantId, directoryObjectId)` oraz fallback `(providerType, issuer, providerSubject)`. E-mail jest snapshotem/jednorazowym mostem, nie permanentnym kluczem. Zmiana/recycling e-maila nie zmienia właściciela identity.

## Z. Legacy first-bind policy

Po walidacji signature/issuer/audience legacy bind jest dozwolony tylko dla dokładnie jednego `Pending`/`Active` User o normalized verified e-mail i bez jakiejkolwiek wcześniejszej ExternalIdentity. Advisory lock serializuje first bind. Unknown lub ambiguous identity dostaje `401`; disabled identity nie może zostać ponownie związana przez e-mail.

## AA. Invitation onboarding

Pierwszy zweryfikowany Entra login konta Pending wymaga aktualnego, niewygasłego invitation dla snapshot e-mail. Identity link, invitation `Accepted`, User `Active`, Audit i outbox commitują atomowo. Local accept tworzy jawny `LOCAL_DEV` identity wyłącznie poza production.

## AB. Invitation expiry / generation

GET tylko wylicza `Expired` i nigdy nie zapisuje. Regenerate zmienia hash/generation/version; revoke zachowuje reason/provenance. Create/regenerate/revoke wspierają UUID `operationId`: ten sam payload zwraca ten sam committed wynik, ponowne użycie z innym payloadem daje `409`.

## AC. Development auth boundary

Ephemeral development session przechowuje tylko transport token→User ID; User i access facts są zawsze czytane z PostgreSQL. `NODE_ENV=production` odrzuca `AUTH_MODE=dev`, memory persistence i local onboarding routes.

## AD. Effective access service

`EffectiveAccessService` jest wspólnym kalkulatorem dla auth middleware, Admin effective-access oraz permission-based Notification recipient resolution. Łączy protected/global roles, poprawnie kwalifikowane group roles i aktywne overrides; DENY ma precedence. Zwraca null dla nie-Active User. `forUser`, `hasEffectivePermission` i batched `eligibleUsersForPermission` korzystają z jednego evaluator graph; scoped projection wymaga aktywnego IncidentAssignment i wiąże GROUP grant z incidentem jego aktywnej grupy.

## AE. Auth middleware integration

`auth.ts` waliduje Entra JWT przez JWKS, issuer i audience, deleguje stable binding do `IdentityAuthService`, a następnie buduje projection z DB. Development bearer session i test header rozwiązują tylko User ID; każdy request ponownie sprawdza trwały stan.

## AF. Audit

Każdy global identity command zapisuje `AuditLog.sessionId=null`, actor, request metadata i bezpieczne metadata targetu. Audit jest w tej samej transakcji co source mutation; test rollback/constraint nie może zwrócić sukcesu bez Audit.

## AG. Notifications outbox integration

Identity command zapisuje `ACCESS_CHANGED` w `NotificationOutbox` w tej samej transakcji. Dispatcher używa bezpiecznej trasy `/settings`, globalnego `sessionId=null` i trwałego dedup key. Delivery failure nie cofa access state; retry/diagnostics pozostają Stage 13 semantics.

`SESSION_CLOSED` rozwiązuje `session:read` wyłącznie przez `EffectiveAccessService.eligibleUsersForPermission`; istniejący postgresowy publisher Briefing używa tego samego entry point dla `briefing:read`, bez dodania Stage 15 ani nowego eventu. GROUP scope nie jest globalizowany przez sam `IncidentAssignment`: role przypisane w grupie incidentu A nie kwalifikują użytkownika do broadcastu incidentu B. Active/expired/revoked GRANT/DENY mają identyczną semantykę jak request authorization. `NotificationDispatcher` nie zawiera osobnego produkcyjnego permission evaluator; direct-recipient events zachowują swoje domain-specific reguły.

## AH. Concurrency

DB unique/partial unique, row locks, wspólny last-admin advisory lock i optimistic versions zamykają: normalized e-mail, duplicate assignment, active group assignment, override, invitation e-mail, stable identity bind, role archive↔assignment i combined last-admin races. Group role assignment oraz Group archive używają wspólnego logical advisory locka i `READ COMMITTED`, dzięki czemu transakcja oczekująca widzi commit zwycięzcy zamiast utrwalonego wcześniejszego snapshotu. Dedykowane testy obejmują wszystkie wyścigi z sekcji 74 oraz właściwe kombinacje z sekcji 75; zmiana authentication policy nie jest trzecią drogą usunięcia admina, ponieważ production policy jest wyłącznie `SSO_ONLY`.

Idempotency została oceniona dla lifecycle User, role assignment/revoke, override create/revoke oraz pełnego invitation/identity onboarding. Invitation commands są retry-sensitive multi-write i używają trwałego `operationId` z fingerprintem oraz replayem tego samego wyniku. Pozostałe komendy są pojedynczymi versioned/unique mutations: jawny stale/duplicate retry kończy się `409`, a frontend nie wykonuje blind retry. Nie udają replayu sukcesu bez trwałego operation record.

## AI. Security tests

Pokryto wrong issuer/audience, unknown identity, e-mail takeover/recycling, disabled identity, brak ważnego invitation dla Pending, production dev-auth rejection, self-elevation, final admin, group-without-incident oraz notification safe route. Closure dodaje jawne przypadki GLOBAL, GROUP correct/wrong incident, GRANT, active/expired/revoked DENY, inactive User, archived Role, revoked GroupRoleAssignment, archived Group, brak IncidentAssignment oraz consistency między scoped `forUser` i recipient eligibility.

## AJ. Paging / scale

Users, invitations, organizations i roles używają server-side `limit/offset`, stabilnego sortowania i total. Test Users tworzy 225 rekordów i weryfikuje trzecią stronę 75 elementów; limit endpointu jest bounded do 200. Recipient discovery wykonuje stałą liczbę batched zapytań relacyjnych, bez per-user N+1 i bez `take`/pierwszej strony; test kwalifikuje wszystkich 1005 przygotowanych kandydatów.

## AK. Frontend

Zachowano Admin information architecture. Users & Access korzysta z trwałych detail/projection/history/commands; auth policy pokazuje tylko Microsoft SSO. Login ma oddzielony Microsoft product action i oznaczony Development access, bez produktu password/email. Smoke sprawdza też mobile overflow i non-admin hiding.

## AL. Backfill / seed

Migracja ma preflight duplicate checks, normalizację e-maili/nazw/statusów, constraints/indexes, nowe tabele, protected role backfill i assignment history. Closure fresh deploy wykonał 17/17 migracji oraz seed. Exact legacy rehearsal z merge Stage 13 (`5038dfb…`), jego 16 migracjami i seedem, a następnie Stage 14 deployem przeszedł; dedykowane 37/37 testów działa na fresh i upgraded DB.

## AM. Legacy removed + LOC

| Obszar | LOC Stage 13 | LOC Stage 14 | Aktywna authority po Stage 14 |
| --- | ---: | ---: | --- |
| `demo-router.ts` | 4208 | 4208 | tylko adapter testowy; Admin/Auth routes są shadowed przez identity router w postgres |
| `auth.ts` | 126 | 65 | PostgreSQL IdentityAuth/EffectiveAccess |
| `access-control.ts` | 187 | 187 | permission helper; fakty z request DB projection |
| `routes/index.ts` | 1330 | 1334 | postgres composition root; identity router montowany przed demo adapterem; permission broadcast przez EffectiveAccess |
| `app.ts` | 108 | 108 | runtime validation + composition |
| `AdminPage.tsx` | 2168 | 2158 | durable Admin API, SSO-only UI |
| `modules/identity/*` | 0 | 776 | auth, scoped effective access, durable commands, dev transport |
| Prisma schema | 1409 | 1550 | canonical identity graph |
| Stage 14 migration / PG test | 0 | 270 / 718 | backfill+constraints / dedicated gate |

Mandatory search nadal znajduje memory writers w `demo-router.ts` (`roles.push`, `users.push`, `externalIdentities.push` i tablica invitations), lecz production `postgres` route order shadowuje wszystkie jego `/auth` i identity `/admin` routes. Różnica route setu to wyłącznie `/admin/dictionaries` (odrębna, jawnie pozostała domena) oraz alias parametru legacy bulk roles, który jest shadowed przez ten sam Express path. `member-directory.ts` lokalne `users.push`/`groups.push` należą do jawnego memory adaptera/testów lub pomocniczej kolekcji wyniku, nie są production identity authority. Legacy in-memory `notifications.ts` pozostaje wyłącznie adapterem automated-test mode. Produkcyjne generic permission recipient scans w `NotificationDispatcher` i composition-root Briefing publisher zostały zastąpione wspólnym `EffectiveAccessService`; pozostały scan w Assignment repository kwalifikuje assignee do commandu, nie odbiorcę broadcastu. Nie znaleziono innego produkcyjnego permission-based Notification evaluator.

## AN. PostgreSQL tests

- Dedicated Stage 14: 37/37 na fresh oraz upgraded Stage 13 DB.
- Pełny Stage 1–14 PostgreSQL: 15 files, 173/173, zero skipów.
- Unit/API bez PostgreSQL: 13 files, 99/99; PostgreSQL suites są świadomie niewłączane do tej komendy, ale mandatory CI gate wywołuje je osobno.

## AO. Browser tests

Playwright: finalnie 71/71. Wbudowany browser runtime był niedostępny (`No browser is available`), więc nie stanowił osobnej bramki.

## AP. CI

Closure local gates: typecheck, Unit 99/99, build, Playwright 71/71, audit (0 vulnerabilities), fresh PostgreSQL 17/17 + seed, legacy Stage 13→14 rehearsal, production startup/health oraz `git diff --check` są zielone. Pełny PostgreSQL ma 173/173, dedicated Stage 14 37/37. Production startup zwrócił `200` na `/api/health` z `persistence=postgres` i `404` dla dev-auth endpointu. Remote exact-SHA closure gate pozostaje wymagany po pushu implementacji oraz ponownie po ewentualnym dokumentacyjnym commicie READY.

## AQ. Remaining split-brain

Production identity split-brain jest usunięty. Memory Admin/Auth i memory Notifications adapter pozostają wyłącznie dla automated test mode i nie są authority w postgres. Permission-based Notifications korzystają z tego samego access graph co authorization. Pozostałe niezależne production memory writes: Briefings/Active Event, Imports, Reports/Exports derivation, Readiness/config projection oraz Admin Dictionaries.

## AR. Risks — max 10

1. Memory `demo-router` nadal istnieje i wymaga route-order regression tests przy kolejnych refactorach.
2. Dev session revocation jest process-local; production revoke-sessions pozostaje jawnie unsupported.
3. Invitation tokenHash nie jest pełnym production secret delivery flow; production accept opiera się na verified Entra first login.
4. Idempotency jest wdrożone dla invitation commands; pozostałe identity commands polegają na version/unique semantics.
5. Frontend bundle nadal raportuje istniejące ostrzeżenie >500 kB.
6. Recipient discovery nie ma page limitu i używa batched relation loading; przy znacznie większej niż przetestowane 1005 populacji może wymagać SQL-side candidate reduction bez rozdzielania semantyki polityki.

## AS. Next decision

Porównanie następnych kandydatów:

| Kandydat | Production writes | Security / integrity | Centrality | Scope / vertical slice |
| --- | --- | --- | --- | --- |
| Briefings / Active Event | draft update, publish | incident-scoped operational truth i publish race | wysoka | spójny, średni vertical slice |
| Imports | upload/confirm | wysoki input-validation risk | średnia | większy, cross-domain |
| Exports / Reports | głównie derived reads | leakage/snapshot consistency | średnia | trudniej odseparować od źródeł |
| Readiness | głównie projection | stale/incorrect readiness | wysoka | zależna od Training/Documents/Groups |
| Admin Dictionaries | create/update config | configuration integrity | średnia | mały, ale mniej centralny |

Wybrany dokładnie jeden następny slice: **Briefings / Active Event persistence** — ma realne production writes, wysoką centralność w pracy incidentowej i da się zamknąć jako jeden vertical slice bez rozpoczynania go w Stage 14.

## Final gate

`NOT READY` — local closure gates są zielone; wymagane jest exact-final-SHA remote CI dla draft PR #11.
