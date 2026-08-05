# Foundation Stage 5 — Matching Report

## A. Stage 4 merge verification

- PR #1 obejmował wyłącznie Foundation Stage 4 Family/NOK, był mergeable i bez konfliktów.
- Foundation PostgreSQL Gate oraz Typecheck/Unit/Build/Browser były zielone. Jedynym czerwonym jobem pozostał zaakceptowany advisory React Router `GHSA-qwww-vcr4-c8h2`; nie pojawiły się nowe findings.
- Draft został zdjęty, a PR scalono standardowym merge commit do `main`: `a1563cb45e33494f39d95392a5851c4320a5badf`.
- Commit Stage 4 `5dbac5f` jest przodkiem `origin/main`. Stage 5 rozpoczęto z czystego, aktualnego `main` na `agent/foundation-stage-5-matching`.

## B. Current Matching contract

Stan zinwentaryzowany przed migracją:

| Operation | Endpoint/caller | Frontend | Legacy memory | Old Prisma | Stage 5 decision |
| --- | --- | ---: | ---: | ---: | --- |
| List queue | `GET /matching-records` | fetch-all board | tak | duplikat | `GET /matching/queue`, paging/filter/sort na serwerze |
| Get context | brak osobnego kontraktu | inspector z list | brak | brak | `GET /matching/claims/:claimId` |
| Suggestions | `/matching-records/suggestions` | pusty/fetch-all | puste | lokalny algorytm | persisted `MatchSuggestion`; stara ścieżka tylko read-only transition projection |
| Manual match | generic POST/PATCH | formularz i DnD | bezpośredni zapis | równoległy zapis | manual `confirm` z nullable `suggestionId` |
| Accept/verify | generic action `verify` | przycisk/DnD | mutacja statusu | mutacja statusu | append-only human `MatchDecision(CONFIRMED)` |
| Reject | generic action `reject` | przycisk | mutacja statusu | mutacja statusu | append-only `REJECTED` dla suggestion |
| Dispute/unmatch | brak stabilnego kontraktu | brak | brak | brak | kontrolowane `invalidate` |
| Reopen | brak | brak | brak | brak | re-confirm stale decision z supersession |
| Score | `MatchingRecord.matchScore` | wyliczany też w React | manual/system mixed | mixed | tylko immutable suggestion score |
| Reasons/signals | `matchBasis`, JSON checklist | wyliczane w browserze | dowolny JSON | dowolny JSON | typed positive signals/conflicts + algorithm provenance |
| Drag-and-drop | generic matching write | dominujący flow | osobny zapis | osobny zapis | usunięty; jedna ścieżka command |
| Keyboard action | board/DnD controls | częściowo | ten sam bypass | ten sam bypass | natywne button/form/dialog, bez alternatywnego write path |
| Passenger lookup | `listAll` | wszystkie rekordy | pełna tablica | pełna lista | scoped, server-paged candidates |
| Family/NOK lookup | `listAll` | wszystkie rekordy | pełna tablica | pełna lista | minimalna matching projection bieżącego claimu |
| Release dependency | raw `MatchingRecord.status`/hold | lista legacy | bezpośredni status | bezpośredni status | read-only compatibility + `releaseEligibility` |
| Audit | generic | niejawny | częściowy | częściowy | actor/reason/versions/operation/algorithm/request |
| Timeline | generic | niejawny | częściowy | częściowy | confirm/manual/invalidate; bez technicznych generations |
| Report/export | raw Matching rows | legacy | memory | fetch-all | wyłącznie read-only compatibility projection |
| Delete | brak UI | brak | możliwa mutacja tablicy | technicznie możliwe | brak publicznego hard delete decyzji |

## C. Field classification

| Class | Fields before Stage 5 | Resolution |
| --- | --- | --- |
| References | session/case/enquiry/family/passenger; brak claim reference | `incidentId`, `relationshipClaimId`, `passengerRecordId`; optional projection links |
| Suggestion data | `matchScore`, `matchBasis`, checklist mieszały źródła | score, positive signals, conflicts, algorithm/version, generation/input versions |
| Human decision | status, notes, approved actor/time | decision, reason, actor/time, suggestion ref, versions, operation/request IDs |
| Workflow/technical | ID/timestamps, bez spójnej wersji | operational ID sequence, row version, current/validity/supersession |
| Legacy/ambiguous | status łączył suggestion/decision/Release; manual score; override; hold | zachowane wyłącznie w kompatybilności; brak publicznych legacy writes |

## D. Matching architecture decision

Jedyny production contract to `MatchingService` + `MatchingRepository` z implementacjami PostgreSQL i testową memory. Wejściem jest bieżący `RelationshipClaim`; sugestia i decyzja są osobnymi encjami. `MatchingRecord` pozostał wyłącznie kontrolowaną projekcją dla konsumentów Release/Dashboard/Reports/Export.

Konserwatywna reguła biznesowa: system może generować sugestie i człowiek może potwierdzić Passenger przed weryfikacją relacji, ale Release wymaga niezależnie `RelationshipClaim VERIFIED` oraz `MatchDecision CURRENT CONFIRMED`.

## E. MatchSuggestion model

Model zapisuje incident, current claim, Passenger, score 0–1, positive signals, conflicts, algorithm/version, generation UUID, claim/passenger input versions, status/currentness, version i timestamps. Partial unique blokuje identyczną aktywną sugestię dla incident + claim + Passenger + algorithm version. Regeneration oznacza wcześniejsze aktywne sugestie jako `OBSOLETE`; historyczny rekord użyty przez decyzję pozostaje dostępny.

## F. MatchDecision model

Model append-only zapisuje `CONFIRMED`, `REJECTED` albo `INVALIDATED`, reason, claim/Passenger, opcjonalne suggestion/projection, input versions, actor/time/request, `operationId`, fingerprint i supersession. Publicznego delete/update decyzji nie ma. `suggestionId = null` oznacza poprawny manual match, nie brak pochodzenia.

## G. Algorithm provenance

Obecna, deterministyczna logika działa jako `zpp-deterministic-candidate` v`1.0.0`. Kandydaci są zawężani w bazie przez explicit Passenger link, nazwisko, flight lub case, maksymalnie do 200 wejść i 100 zapisanych sugestii. Score jest względną oceną tej konkretnej wersji; nigdy nie wywołuje automatycznego confirm.

## H. API contract

- `GET /matching/queue`
- `GET /matching/claims/:claimId`
- `GET /matching/claims/:claimId/suggestions`
- `POST /matching/claims/:claimId/suggestions/generate`
- `GET /matching/claims/:claimId/candidates`
- `POST /matching/claims/:claimId/confirm`
- `POST /matching/claims/:claimId/reject`
- `POST /matching/claims/:claimId/invalidate`
- `GET /matching-records` — read-only compatibility projection
- hold/clear-hold pozostają kontrolowanymi akcjami projection, bez prawa do tworzenia decyzji.

Queue, candidates i suggestions obsługują paging i sort; queue obsługuje search/state/relationship status, a suggestions status i presence of conflicts.

## I. Human decision workflow

Confirm w jednej transakcji sprawdza writable incident, current claim, Passenger, input versions, current suggestion oraz konflikt bieżącej decyzji; następnie tworzy projection i decision, aktualizuje użycie suggestion, zapisuje audit i timeline. System nie weryfikuje relacji, nie zmienia Passenger state, nie czyści hold i nie uruchamia Release.

## J. Manual matching

Manual candidate search jest incident-scoped i server-paged. Manual confirm przechodzi przez ten sam command, optimistic concurrency, operation ID, audit i timeline. Nie tworzy sugestii ani sztucznego score; compatibility zwraca `matchScore: null` i `source: manual`.

## K. Stale/superseded semantics

Efektywna ważność wynika z currentness claimu oraz zapisanych claim/Passenger versions. Korekta tworząca nowy claim albo meaningful Passenger source correction natychmiast daje `STALE / Requires review` w kolejce i Release projection. Ponowne jawne potwierdzenie może zastąpić tylko stale decision; wcześniejsza decyzja staje się `SUPERSEDED` i pozostaje w historii. `invalidate` również wymaga reason i tworzy nową historyczną decyzję.

## L. RelationshipClaim interaction

Matching nie czyta płaskich Family fields jako source of truth. Stary claim i jego suggestions/decisions nie są przepinane do claimu po korekcie. Match confirm nie wywołuje Family verify/reject/reopen. Wiele niezależnych claimów NOK może mieć current confirmed match do jednego Passenger.

## M. Passenger interaction

Decyzja zapisuje Passenger version bez kopiowania PII. Source correction zwiększająca version unieważnia efektywną aktualność matcha. Confirm nie zmienia SRC confirmation, condition ani hold.

## N. Release compatibility

Read model jawnie zwraca:

- relationship verification: `VERIFIED / NOT_VERIFIED`;
- match decision: `CURRENT_CONFIRMED / NOT_CONFIRMED / STALE`;
- Passenger hold i condition;
- matching hold;
- `eligible` oraz blockers.

Legacy Release nie ufa już surowemu `MatchingRecord.status`; przygotowanie i completion ponownie sprawdzają projection. Stage 5 nie rozpoczął redesignu Release.

## O. Security / IncidentContext

Każda operacja przechodzi authentication → istniejące `matching:*` permission → `IncidentAssignment` → `IncidentAccessService` → MatchingService/Repository. Matching projection wystawia minimalne dane potrzebne do decyzji bez bocznego nadawania pełnych Family/Passenger permissions. Revoke daje 404 przy następnym request; Closed/Archived jest read-only. REAL/EXERCISE/TRAINING nie współdzielą queue, candidates, suggestions ani decisions. Triggery PostgreSQL chronią claim/Passenger/suggestion/projection przed cross-incident links.

## P. Concurrency + idempotency

Commands wymagają expected claim, Passenger i suggestion/projection versions. Partial unique index dopuszcza tylko jeden current confirmed decision per incident + claim; PostgreSQL race dwóch operatorów kończy się jednym sukcesem i jednym 409. Unique `(incidentId, operationId)` i fingerprint sprawiają, że retry tej samej komendy po timeout zwraca istniejący wynik, a reuse ID z inną komendą daje 409.

## Q. Audit/timeline

Audit decyzji zawiera actor, incident, claim, Passenger, optional suggestion, action/result/reason, algorithm/version/score reference, input versions, operation ID, request ID i server timestamp, bez kopiowania PII. Timeline zapisuje suggested/manual confirmation oraz invalidation; generation nie generuje szumu timeline.

## R. Frontend/UX

`MatchingPage` został zastąpiony server-driven claim queue. Operator widzi relationship status osobno od match state, persisted suggestions, score provenance, signals/conflicts, algorithm generation, decision history i stale warning. Explicit dialog pokazuje strony decyzji, relationship warning, evidence/conflicts, reason oraz stable operation ID. `409` nie jest automatycznie retry; dialog zachowuje operation ID. Manual search jest paged. DnD, browser score i generic create/edit zostały usunięte; keyboard flow korzysta z natywnych controls i focus-managed dialog.

## S. Legacy removed + LOC

Usunięto aktywne memory i stare Prisma Matching CRUD/verify/reject/suggestions write paths, browser DnD write oraz manual score. Pozostała tylko odczytowa transition/compatibility surface.

```text
demo-router.ts before: 4553
demo-router.ts after:  4482

routes/index.ts before: 2317
routes/index.ts after:  1991
```

`MatchingPage.tsx` zmniejszył się z 2425 do 519 linii.

## T. Tests

- Prisma format/validate/generate: PASS.
- Typecheck: PASS.
- API unit/memory: PASS (91 tests; PostgreSQL suites lokalnie skipped bez `TEST_DATABASE_URL`, zero skipped w CI gate).
- Build: PASS.
- Browser: PASS (57/57), w tym explicit confirm/reject, manual candidate, stale/409, signals/conflicts, brak auto-NOK verification i brak auto-Release.
- Stage 5 PostgreSQL suite obejmuje migration assets, restart persistence, assignment/revoke/permission/closed/cross-mode, direct DB isolation, suggestion≠decision, manual match, independence, real concurrency, idempotent timeout retry, stale claim, stale Passenger, multiple NOK, regeneration history, 1000×Family/Passenger paging/narrowing i legacy bypass.
- Migration rehearsal backfilluje historyczny `MatchingRecord` do immutable suggestion + human decision i sprawdza linkage/currentness.

## U. CI

Foundation PostgreSQL Gate uruchamia świeżą migrację i seed, API startup, Stage 1–5 integration suites oraz rozszerzony backfill rehearsal. Quality uruchamia Typecheck, API, Build i wszystkie browser smoke. Dependency audit pozostaje niesuppressowany.

Publikacyjne identyfikatory (commit, PR i run ID) są uzupełniane w opisie PR oraz końcowym handoffie po zakończeniu remote gate.

## V. Remaining split-brain

- `MatchingRecord` i jego stare, dwuznaczne kolumny istnieją jeszcze jako read-only compatibility projection dla Release/Dashboard/Reports/Export.
- Deprecated `GET /matching-records/suggestions` istnieje tymczasowo jako read-only transition endpoint; nie podejmuje i nie zapisuje decyzji.
- Release pozostaje legacy slice i jest kolejnym świadomym krokiem; Stage 5 wyłącznie dostarcza bezpieczny precondition read model.

Nie istnieje production dual-write ani drugi Matching decision implementation.

## W. Risks

1. React Router `GHSA-qwww-vcr4-c8h2` pozostaje jedynym znanym dependency advisory i nie jest suppressowany.
2. Legacy `MatchingRecord` schema nadal jest semantycznie szersza niż docelowa projection do czasu Release slice.
3. Deterministyczne candidate narrowing jest celowo proste; brakujące/niestandardowe dane wymagają manual search.
4. Suggestion generation działa synchronicznie i jest limitowane do 200 candidates/100 suggestions; worker queue jest świadomie poza zakresem.
5. Queue pobiera szczegóły tylko dla bieżącej strony (max 200), lecz nadal wykonuje kilka relacyjnych zapytań na item; wymaga obserwacji przy skali znacznie większej niż testowe 1000.
6. Nie ma jeszcze globalnego outbox; audit/timeline są atomowe w tej samej transakcji Matching, ale integracje zewnętrzne będą osobnym etapem.
7. Read-only transition endpoints powinny zostać usunięte po migracji ostatnich legacy consumers.

## X. Next decision

```text
READY FOR RELEASE SLICE
```

Warunek operacyjny: remote Foundation PostgreSQL i Quality/Browser gates dla PR Stage 5 muszą zakończyć się PASS; jedynym dopuszczonym czerwonym jobem pozostaje jawnie zaakceptowany React Router advisory. Nie rozpoczęto Release.
