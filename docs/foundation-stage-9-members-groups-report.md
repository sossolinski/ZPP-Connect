# Foundation Stage 9 — Member Profiles + Groups Report

## A. Stage 8 foundation verification

Prace rozpoczęto z czystego `origin/main` na merge commit `003ed695d3dda1dda7eb02651f0b86b9c448d5d3`. Finalny commit Stage 8 `959844e` jest jego przodkiem. Gałąź robocza: `agent/foundation-stage-9-members-groups`.

## B. Current Member contract

Przed Stage 9 MemberProfile był mutowalnym rekordem w pamięci. Te same tablice zasilały Members, Groups, Rostering, Availability, Training, Documents, Readiness, Notifications oraz część Admin. ID powstawało lokalnie, link User nie miał ochrony bazy, a derived availability/training/roster/leader mogły wyglądać jak autorytatywne pola Member.

Po Stage 9 produkcyjny kontrakt Member prowadzi wyłącznie przez modularny router/service/repository i PostgreSQL. Legacy repository pozostaje test double oraz read-only compatibility projection dla niemigrowanych konsumentów; nie zapisuje z powrotem do PostgreSQL.

## C. Current Group contract

Przed Stage 9 Group i GroupMembership były memory-only. `memberIds`, `leaderId` i `rosterShiftIds` były mutowane razem przez generic PATCH, historia membership zanikała, a group-scoped RoleAssignment wskazywał na nietrwały identyfikator.

Po Stage 9 Group facts, membership, leadership i group role scopes mają osobne relacyjne ścieżki. Generic Group PATCH nie przyjmuje member IDs, leader ani roster links. Stare routes są montowane wyłącznie w memory test mode.

## D. Entity separation

```text
User               = identity, authentication i RBAC principal
MemberProfile      = globalny operacyjny profil osoby
GroupMembership    = historyczna relacja MemberProfile ↔ incident Group
IncidentAssignment = jedyne źródło dostępu User do Incident
```

`linkedUserId` jest opcjonalnym FK, nie dziedziczeniem identity. Membership nie tworzy permission, RoleAssignment ani IncidentAssignment.

## E. Member field classification

- Authoritative identity/facts: `id`, `memberId`, `firstName`, `lastName`, `pool`, `role`, `assignedFunction`, `languages`, `status`.
- Optional identity link: `linkedUserId` do istniejącego aktywnego User.
- Contact PII: `contactEmail`, `normalizedContactEmail`, `phone`.
- Provenance/concurrency: `version`, created/updated actor i timestamps.
- Compatibility-only: `legacyAvailability`, `legacyTrainingStatus`, `legacyRosterStatus`, `legacyAssignedLeader`.
- Derived response labels: `availability`, `trainingStatus`, `rosterStatus`, `assignedLeader`, jawnie oznaczone jako legacy compatibility.

## F. Group semantics decision

Wybrano wariant **incident-scoped**. Istniejący produkt tworzył i edytował grupy w kontekście aktywnej Session, Groups UI pokazywał bieżący Incident, a roster links były incident-operational. `OperationalGroup.incidentId` jest wymaganym FK do Session. Read/write konkretnej grupy wymaga tego samego Incident; write dodatkowo wymaga writable Incident. Globalny MemberProfile może należeć do wielu grup w różnych Incidentach.

## G. MemberProfile model

`MemberProfile` ma trwały techniczny ID, zachowany business `memberId`, opcjonalny User FK, facts, contact PII, status, version i provenance. Business/technical IDs korzystają z PostgreSQL sequences. Active e-mail jest normalizowany i chroniony partial unique indexem. Hard delete nie jest API contractem.

## H. linkedUser semantics

Link wskazuje wyłącznie na istniejącego aktywnego User. Partial unique index gwarantuje maksymalnie jeden niearchiwalny MemberProfile dla User. Nonexistent User jest odrzucany; równoległy duplicate link daje jeden sukces i jeden `409`. Archiwizacja profilu usuwa link. Admin compatibility ID jest mapowany do rzeczywistego User po stabilnym normalized e-mailu; nowe zaproszenie nie może linkować Member przed powstaniem persisted User.

## I. Group model

`OperationalGroup` przechowuje `operationalId`, wymagany `incidentId`, name, pool, function, status, notes, version i provenance. ID/operational ID korzystają z atomic sequences. Lista obsługuje incident, search, pool, status, function, sort i limit/offset. System Admin zachowuje globalny katalog; inni aktorzy bez jawnego Incident widzą tylko IncidentAssignments.

## J. GroupMembership model

Membership jest osobną historyczną tabelą z role, added/removed actor i timestamps. Remove ustawia `removedAt`, nie usuwa wiersza. Partial unique `(groupId, memberProfileId) WHERE removedAt IS NULL` chroni active duplicate. Ten sam Member może równocześnie należeć do wielu grup. Trigger nie pozwala tworzyć active membership do archived Member lub Group.

## K. Leader source of truth

Jedynym source of truth jest active `GroupMembership.role = 'Leader'`. Partial unique index dopuszcza najwyżej jednego active leadera na grupę. Leader musi być active memberem. `set-leader` demotuje poprzedniego i promuje nowego atomowo. Usunięcie lidera najpierw kończy jego membership, a następnie promuje najstarszego pozostałego membera; bez pozostałych członków grupa może chwilowo nie mieć lidera.

## L. Permissions and Group scope

`UserRole.scopeType` rozróżnia `GLOBAL` i `GROUP`. `GroupRoleAssignment` przechowuje User, Role, Group, lifecycle, version i provenance. Admin assign/revoke/replace aktualizuje scope transakcyjnie w PostgreSQL; revoke i archive Group natychmiast wyłączają grant. Permission scope korzysta z aktywnych assignmentów i nie rozszerza custom group role do globalnego dostępu. System Admin pozostaje globalny.

## M. Contact PII policy

Redakcja jest backend-side. Phone, contact e-mail i linkedUserId są zwracane wyłącznie aktorowi z dozwolonym contact-management zakresem (`member:update`, `member:create` lub admin). Group/read-only actor otrzymuje profil bez tych pól. Search działa w bazie, ale odpowiedź nadal jest redagowana. Audit zapisuje nazwy pól i present/absent/linked classifications, nigdy pełne wartości contact.

## N. Incident access non-escalation

Group read/write najpierw przechodzi przez `IncidentAccessService`. Membership ani `GroupRoleAssignment` nie tworzą IncidentAssignment. Test z poprawnym group role, lecz bez IncidentAssignment, dostaje `404`. REAL, EXERCISE i TRAINING są izolowane przez UUID Incident; closed Incident pozostaje historycznie czytelny, ale read-only.

## O. Lifecycle / archive

Member może być Inactive bez utraty historii. Archive jest blokowane, gdy istnieje active membership; zachowanie jest wymuszone również triggerem. Archive Group w jednej transakcji kończy wszystkie active memberships, revokuje active group role scopes, ustawia status Archived, zwiększa version i tworzy audit. Restore Member jest jawne i wersjonowane; Group restore nie został dodany, bo current contract go nie definiował.

## P. Concurrency

Każdy update/archive/membership/leader write wymaga `expectedVersion`. Stale writer dostaje `409`, bez auto-overwrite. Group mutations lockują grupę i używają serializable transaction; serialization/unique races są mapowane na `409`. Create IDs używają sequences. Create Group lockuje wybranych MemberProfiles i używa Read Committed, dzięki czemu niezależne równoległe creates nie generują fałszywych konfliktów, a archive-vs-membership pozostaje bezpieczne.

## Q. Transactions

Create/update/archive/restore Member, create/update/archive Group, add/change/remove membership, set leader oraz persistent group RoleAssignment obejmują validation, row locks, mutation, version i AuditLog w jednej transakcji. Member archive i membership add współdzielą blokadę Member row. Group archive i scoped-role grant współdzielą blokadę Group row, więc żaden wyścig nie pozostawia aktywnej relacji do zarchiwizowanego rekordu. Group archive obejmuje membership i RBAC revoke. Nie ma dual-write do PostgreSQL z compatibility cache; cache jest aktualizowany dopiero z committed response.

## R. Audit

Audit przechowuje actor, action, entity/member/group ID, role/member transition, version before/after, requestId i server timestamp. Member changed fields obejmują również phone/e-mail jako nazwy, lecz values są klasyfikowane tylko `present/absent`; linked User jako `linked/unlinked`. Leader audit zawiera previous/next leader ID. Zwykłe global directory changes nie tworzą CaseTimelineEvent.

## S. Derived Roster/Training fields

Availability, Training status, Roster status i assigned leader nie są writable Member facts. UI pokazuje je jako disabled derived/Rostering projections. Strict API schemas odrzucają je w Member create/update. `rosterShiftIds` nie zostało utrwalone jako JSON workaround; Group pokazuje read-only compatibility links do czasu właściwego Rostering slice.

## T. Compatibility consumers

Rostering, Availability, Training, Documents i Readiness czytają compatibility projection hydratowany z PostgreSQL Member/Group responses. Projection zachowuje niemigrowane derived dane, ale nie wywołuje żadnego Member/Group write-back. Test potwierdza odczyty czterech konsumentów oraz brak zmiany PostgreSQL po ich użyciu.

## U. Backfill / seed

Migracja tworzy nowe tabele bez fabrykowania historii, bo wcześniejsze Members/Groups żyły wyłącznie w memory seed. Durable seed zachowuje 10 business member IDs, 4 group operational IDs, 12 memberships i leadership. `linkedUserId` jest ustawiany wyłącznie po znalezieniu real User po e-mailu. ZPP Group Leader otrzymuje `UserRole.scopeType = GROUP` oraz trwały scope do Alpha. Sequences są ustawiane ponad fixture maxima.

## V. API

- Members: paged list, detail, create, PATCH, archive, restore, eligible User search.
- Groups: paged list, detail, create, PATCH, archive.
- Membership: paged list, add, role change, remove.
- Leadership: osobny `POST /groups/:id/set-leader`.
- Admin group RBAC: istniejące assign/revoke/replace routes zapisują scopes w PostgreSQL.

Schemas są strict, list limits wynoszą maksymalnie 200, a writes używają stable IDs i expectedVersion.

## W. Frontend / UX

Members używa server paging/search/pool/status/function/sort, pokazuje server total i wysyła tylko authoritative fields. Create/edit/archive obsługuje version i pozostawia drawer otwarty z komunikatem po `409`. Globalne sortowanie nie oferuje legacy-derived Availability/Leader, bo nie byłyby wiarygodne dla pojedynczej strony. Groups używa bounded server list, ładuje członków stroną 200 i wyszukuje kandydatów stroną 50; add/remove/leader/archive to osobne commands. Roster links i derived Member fields są read-only. Nie ma browser fetch-all dla Member/Group.

## X. Legacy removed + LOC

Aktywne production Member/Group generic routes są wyłączone, gdy istnieje PostgreSQL repository. Admin link i GROUP RoleAssignment nie zapisują już tylko do memory. Legacy repository pozostaje testowym memory contractem i compatibility cache.

```text
demo-router.ts:          4081 -> 4143
member-directory.ts:    1020 -> 1107
routes/index.ts:         1332 -> 1338
VolunteersPage.tsx:       811 -> 835
GroupsPage.tsx:           927 -> 1005
new modular directory:          1172 LOC
Stage 9 PostgreSQL tests:         349 LOC
Stage 9 browser tests:            208 LOC
migration:                         155 LOC
```

## Y. PostgreSQL tests

- Fresh PostgreSQL 16: 12 migrations, seed i startup PASS.
- Stage 1–9 real PostgreSQL: **67/67 PASS, zero skipped**.
- Stage 9: 11 scenarios obejmujących persistence/restart, archive/restore/inactive, IDs, 20-member i 10-group bursts, linked User race, PII, incident isolation, closed Incident, membership history/race/multiple groups, leader/removal, archive guards, archive-vs-membership i archive-vs-scoped-role races, persistent group RBAC/revoke, System Admin, non-escalation, atomic Group archive, 1000 Member scale i compatibility/no-write-back.
- Prisma generate/validate/migrate status: PASS.

## Z. Browser tests

Nowe 2 scenariusze Stage 9 PASS: bounded server pagination/search, contact display dla admina, create/edit/archive Member, derived fields disabled, stale Member `409`, controlled membership add/remove, multiple groups, archive Group, roster links read-only oraz stale Group `409`. Finalny pełny lokalny i zdalny suite: **63/63 PASS**.

## AA. CI

Workflow został rozszerzony o Stage 9 w `test:postgres`, nazwę Stage 1–9 oraz dokładny legacy rehearsal nowej migracji/tabel/sequences. Wymagane jobs: fresh migration/seed/startup + PostgreSQL + backfill; Typecheck/Unit/Build/Browser; Production Dependency Audit.

Finalny stan implementacyjnego HEAD `d162fabe423e71c5827b50f565cc0a9f7ef20e4a` na Draft PR #6:

- Typecheck: PASS.
- Unit: 96/96 PASS.
- Build: PASS (istniejące ostrzeżenie Vite o wielkości chunku).
- Exact legacy backfill rehearsal: PASS, łącznie z tabelami i sequences Stage 9.
- Production Dependency Audit: PASS, zero findings.
- Remote CI push run [31371574138](https://github.com/sossolinski/ZPP-Connect/actions/runs/31371574138): wszystkie trzy jobs PASS.
- Remote CI pull-request run [31371578388](https://github.com/sossolinski/ZPP-Connect/actions/runs/31371578388): wszystkie trzy jobs PASS.

Pierwsze workflow dla `d3068f516ad9f13766145340da9387de0c194177` wykryły jedną wadliwą asercję legacy w teście Assignment: test odczytywał niesynchronizowany widok po zmianie persony i oczekiwał, że ZPP Group Leader nie może zarządzać incident-scoped Assignment. Harness został zsynchronizowany z odpowiedzią właściwej sesji, a asercja dostosowana do utrwalonego w Stage 8 kontraktu `IncidentAssignment`; nie zmieniono semantyki produktu ani uprawnień. Targeted test 4/4, pełny lokalny Browser 63/63 i oba ponowione remote workflows są zielone.

## AB. Remaining split-brain

- Rostering i Availability nadal zapisują w pamięci i są głównym następnym consumerem trwałych Member/Group.
- Training, Documents i Readiness pozostają memory-backed, lecz tylko czytają Member/Group projection.
- Notifications i Briefings pozostają niemigrowane.
- Admin/User identity lifecycle nadal ma compatibility UI state; Stage 9 utrwala dokładnie linkedUser i role scopes potrzebne Member/Group, ale nie migruje całego Identity/Admin workflow.
- Legacy derived Member fields pozostają seed/projection do czasu migracji ich właścicieli.
- Group member drawer hydratuje maksymalnie 200 current members na raz; większa grupa wymaga pełnego paged UI w przyszłości.

Nie istnieje drugi aktywny production Member/Group command implementation ani write-back z legacy consumers.

## AC. Risks

1. Compatibility caches pozostają zależnością niemigrowanych consumers do czasu ich osobnych slices.
2. Roster/Availability state nadal znika po restarcie i nie może być traktowany jako MemberProfile truth.
3. Historyczne memory timestamps/actors nie zostały sfabrykowane; durable demo seed ma jawny seed provenance.
4. Contact search wymaga odpowiedniej roli, ale duża skala może później wymagać trigram/full-text indexu.
5. Group UI pokazuje jedną bounded stronę current members; bardzo duże grupy potrzebują pagination controls.
6. Archived Group nie ma restore command, zgodnie z current contractem.
7. Brak lidera jest dozwolony tylko dla pustej grupy; proces operacyjny powinien uzupełnić lidera po pierwszym członku.
8. Pełny Admin/Identity workflow pozostaje poza Stage 9, mimo że wymagane group scopes i member links są już durable.

## AD. Next decision

```text
READY FOR ROSTERING / AVAILABILITY SLICE
```

Stage 9 domyka trwały Member/Group ownership i pozostawia Draft PR gotowy do przeglądu. Następnym rekomendowanym pionowym slice'em jest Rostering / Availability, ponieważ to największy pozostały write-owning consumer Member/Group, nadal memory-backed i tracący stan po restarcie. Stage 9 nie rozpoczyna tego slice'a.
