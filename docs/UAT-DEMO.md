# Rollands Demo v1 – sammanhängande UAT-demo

Den öppna GitHub Pages-demon är nu byggd för att granskas som **ett enda småföretagssystem** i stället för som fristående exempelsidor. All demodata är fiktiv och sparas endast lokalt i användarens webbläsare.

## Officiell demokedja

`publik Rollands-webb → Demoportal → Översikt → Kunder/Kundfakturor/Kundreskontra → Bank/Automation → Bokföring/Rapporter → Leverantörer/Lager/Lön/Dokument/Webbplats`

`apps/portal/demo-scenario.js` är den gemensamma demodatakällan. `apps/portal/demo-workflows.js` innehåller de kontrollerade arbetsflöden som ändrar flera moduler samtidigt.

## Försäljning

Demon innehåller ett gemensamt kundregister. En ny fiktiv kund kan skapas och blir omedelbart valbar i Kundfakturor.

En kundfaktura går genom följande kedja:

1. välj eller skapa kund,
2. ange fakturadatum, förfallodatum, rad, antal, pris och moms,
3. spara fakturan som **Utkast**,
4. förhandsvisa fakturan och skriv ut/spara PDF via webbläsaren,
5. välj **Bokför & skicka demo**,
6. fakturan blir **Bokförd**, får samma fakturanummer/OCR genom hela systemet och skapar en balanserad verifikation:
   - Debet `1510 Kundfordringar`,
   - Kredit `3010 Försäljning`,
   - Kredit `2611 Utgående moms`,
7. fakturan visas direkt i Kundreskontra.

## Kundinbetalning

Huvudscenariot använder faktura `310002` till **Nordic Office Göteborg AB**, som har `3 925,00 kr` kvar att betala.

1. En redan registrerad demobankhändelse har referens `310002` och samma belopp.
2. Bankmatchningen föreslår samma faktura.
3. Automationskön visar Debet `1930 Företagskonto / bank` och Kredit `1510 Kundfordringar`.
4. När det granskade förslaget godkänns i demon genomförs den kontrollerade demohändelsen:
   - bankhändelsen markeras bokförd,
   - kundfakturans restbelopp blir noll,
   - fakturan blir **Betald**,
   - en balanserad betalningsverifikation skapas.

**CAMT/BAM och verklig bankfilimport ingår uttryckligen inte i Demo v1.** Bankmodulen använder förregistrerade fiktiva bankhändelser tills bankfilsspåret tas upp igen.

## Leverantörsfakturor och betalning

Gemensamma exempel:

- `KE-2088`, **Kustens Emballage AB**, 589,00 kr – granskning och konteringsförslag.
- `BKS-771`, **Billdal Kyla & Service AB**, 4 375,00 kr – komplett attest- och betalningsflöde.
- `GF-8821`, **Göteborg Fruktlager AB**, 846,00 kr – redan betald faktura med dokument- och bokföringsspår.

För `BKS-771` är kedjan:

1. fakturan är attesterad,
2. leverantörsskulden bokförs,
3. betalningen förbereds,
4. en separat användarroll frisläpper den,
5. en fiktiv bankbekräftelse registreras,
6. fakturan blir betald och en balanserad verifikation skapas med Debet `2440` och Kredit `1930`.

Demon påstår aldrig att riktiga pengar har skickats.

## Leverantörer

Leverantörsregistret använder samma leverantörs-id som fakturorna. Ändringar av känsliga betalningsuppgifter går till separat godkännandekö innan aktiv masterdata ändras.

## Lager

Lagerartiklar, rörelser och inventeringsjusteringar ligger i samma demostate som dashboarden. Demon stöder:

- inleverans,
- försäljning,
- svinn,
- inventeringsdifferens,
- separat godkännande/avslag av justering,
- uppdaterat lagersaldo efter godkännande.

## Lön

Endast fiktiva och aggregerade lönebelopp används. En lönejournal kan importeras/valideras och därefter bokföras. Bokföringen skapar en verifikation i samma `accountingEntries` som Bokföring och Rapporter läser.

## Dokument

Dokument använder samma interna affärs-id som andra moduler. Originalprincip, kategori, metadata och SHA-256-exempel visas utan att riktiga företagsfiler publiceras på GitHub Pages.

## Bokföring och rapporter

Bokföringssidan läser samma verifikationer som kundfakturering, kundbetalningar, leverantörsbetalningar och lön skapar. Originalverifikationer redigeras inte; rättelser skapar motverifikationer. Periodlås och upplåsningskö ingår.

Rapporterna räknas från samma gemensamma demodata:

- balanslista,
- huvudbok,
- resultatrapport,
- momsavstämningsunderlag.

Momsavstämningen är ett kontrollunderlag och ska inte beskrivas som färdig momsdeklaration.

## Webbplats och CMS

Den publika Rollands-webben har en tydlig väg till Demoportalen. Webbplats & innehåll i portalen används för utkast/förhandsvisning av redigerbart webbplatsinnehåll. Juridiska kärnuppgifter hålls separerade från marknadsinnehåll.

## UAT

`/portal/uat.html?demo=1` är den officiella testguiden och går igenom 16 steg från publik webb till helhetsbedömning. Varje steg kan markeras som Ej testad, Godkänd, Fel/behöver rättas eller Önskad ändring.

**Återställ demoscenario** återställer all gemensam fiktiv affärsdata och UAT-status.

## Automatiska kontroller

`test/demo-scenario.test.js` kontrollerar bland annat att:

- kundregister och kundfakturering använder samma affärsobjekt,
- en bokförd kundfaktura skapar balanserad 1510/3010/2611-verifikation,
- bankmatchningen använder exakt samma restbelopp och faktura,
- en genomförd kundinbetalning nollar reskontran och skapar balanserad 1930/1510-verifikation,
- automationsförslag pekar på befintliga leverantörsfakturor,
- dokumentlänkar pekar på befintliga affärsobjekt,
- leverantörsbetalning kräver rätt ordningsföljd,
- ett fullföljt leverantörsbetalningsflöde nollar 2440,
- lagerjusteringar pekar på befintliga artiklar,
- lönejournaler och samtliga initiala demoverifikationer balanserar.

Det statiska bygget kräver dessutom att alla huvudmoduler för Demo v1 finns med innan GitHub Pages kan publiceras.

## Avgränsning

Demo v1 är en **gransknings- och demonstrationsmiljö**, inte en produktionsmiljö. Den ersätter inte verklig bankintegration, personlig produktionsinloggning/MFA, PostgreSQL, skyddat dokumentarkiv, redovisningsgranskning eller myndighetsflöden.
