# Kundfaktura – exakt PDF-arkiv

Senast uppdaterad: 2026-09-18.

## Vad som skyddas

När en ny kundfaktura utfärdas i den privata backendvägen genereras kundens PDF innan bokföringstransaktionen startar. Samma PDF-bytes lagras sedan tillsammans med fakturan, bokföringsposten, fakturans JSON-underlag och idempotensbevis i samma databastransaktion.

En ny faktura ska därför inte kunna bli bokförd om PDF-genereringen misslyckas. PDF:n som senare öppnas från fakturalistan är den arkiverade filen, inte en nygenererad kopia.

Arkivet sparar faktura-id och företag, exakt binärt PDF-innehåll, SHA-256-fingeravtryck, filstorlek, generatorversion och arkiveringstidpunkt. Arkivtabellen är append-only.

## Integritetskontroll

PDF:n lämnas bara ut om filstorleken stämmer, filen har PDF-signatur och SHA-256 för de aktuella byten stämmer med det sparade fingeravtrycket. Restore-verifieringen gör samma kontroll i en återställd testkopia.

## Idempotens

Varje ny fakturabegäran sparar ett fingeravtryck av affärsinnehållet tillsammans med request-ID. Ett identiskt återförsök returnerar samma faktura. Samma request-ID med ändrat fakturainnehåll stoppas med konflikt.

## Viktig begränsning

Detta gäller fakturor som skapas efter att funktionen införts. En äldre faktura där exakt utsänd PDF aldrig sparades kan inte i efterhand få ett bevisat original genom att en ny PDF genereras från historiska data.

Detta löser inte hela arkiveringskravet. Extern lagringsplats, retention, långtidsläsbarhet, behörighetsrutiner, export och återläsning under hela bevarandetiden måste fortfarande verifieras i pilotens driftmiljö.
