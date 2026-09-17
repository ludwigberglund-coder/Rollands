(function(){
  'use strict';

  const VERSION='2026-09-17-demo-v2';
  const STORAGE_KEY='rollands-integrated-demo-state-v2';
  const AS_OF_DATE='2026-09-17';

  const customers=[
    {id:'cust-demo-1',customerNumber:'K-1001',name:'Västra Hamnen Logistik AB',orgNumber:'559201-1001',email:'ekonomi@vastrahamnen.example',phone:'031-555 10 01',paymentTermsDays:30,customerType:'business',reminderFeeAgreed:true,active:true},
    {id:'cust-demo-2',customerNumber:'K-1002',name:'Nordic Office Göteborg AB',orgNumber:'559201-1002',email:'faktura@nordicoffice.example',phone:'031-555 10 02',paymentTermsDays:30,customerType:'business',reminderFeeAgreed:true,active:true},
    {id:'cust-demo-3',customerNumber:'K-1003',name:'Havsbris Konferens AB',orgNumber:'559201-1003',email:'ekonomi@havsbris.example',phone:'031-555 10 03',paymentTermsDays:30,customerType:'business',reminderFeeAgreed:false,active:true},
    {id:'cust-demo-4',customerNumber:'K-1004',name:'Majorna Fastigheter AB',orgNumber:'559201-1004',email:'leverantor@majornafast.example',phone:'031-555 10 04',paymentTermsDays:30,customerType:'business',reminderFeeAgreed:true,active:true}
  ];

  const customerInvoices=[
    {id:'demo-i1',customerId:'cust-demo-1',kind:'customer',customerNumber:'K-1001',customerName:'Västra Hamnen Logistik AB',invoiceNumber:'310001',ocr:'310001',invoiceDate:'2026-08-18',postingDate:'2026-08-18',dueDate:'2026-09-10',netOre:336000,vatOre:84000,totalOre:420000,remainingOre:420000,status:'Förfallen',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',revenueAccount:'3010',batchNumber:'1028',journalNumber:'K1',customerType:'business',reminderFeeAgreed:true,commentCount:1,comments:[{id:'demo-c1',text:'Kunden har bekräftat att betalning kommer denna vecka.',authorName:'Demo Ekonomi',createdAt:'2026-09-15T10:00:00Z'}],transactions:[],reminders:[{id:'demo-r1',sentAt:'2026-09-15T09:00:00.000Z',kind:'payment-reminder'}],lines:[{description:'Företagsfrukt augusti',quantityMilli:1000,unitPriceOre:336000,vatBasisPoints:2500,netOre:336000,vatOre:84000,grossOre:420000}]},
    {id:'demo-i2',customerId:'cust-demo-2',kind:'customer',customerNumber:'K-1002',customerName:'Nordic Office Göteborg AB',invoiceNumber:'310002',ocr:'310002',invoiceDate:'2026-08-22',postingDate:'2026-08-22',dueDate:'2026-09-21',netOre:628000,vatOre:157000,totalOre:785000,remainingOre:392500,status:'Delbetald',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',revenueAccount:'3010',batchNumber:'1029',journalNumber:'K2',customerType:'business',reminderFeeAgreed:true,commentCount:0,comments:[],reminders:[],transactions:[{id:'demo-t1',transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:'2026-09-10',postingDate:'2026-09-10',batchNumber:'1041',journalNumber:'A41',amountOre:-392500,approved:true,account:'1930'}],lines:[{description:'Fruktleveranser augusti',quantityMilli:1000,unitPriceOre:628000,vatBasisPoints:2500,netOre:628000,vatOre:157000,grossOre:785000}]},
    {id:'demo-i3',customerId:'cust-demo-3',kind:'customer',customerNumber:'K-1003',customerName:'Havsbris Konferens AB',invoiceNumber:'310003',ocr:'310003',invoiceDate:'2026-09-02',postingDate:'2026-09-02',dueDate:'2026-10-02',netOre:1008000,vatOre:252000,totalOre:1260000,remainingOre:1260000,status:'Bokförd',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',revenueAccount:'3010',batchNumber:'1030',journalNumber:'K3',customerType:'business',reminderFeeAgreed:false,commentCount:0,comments:[],transactions:[],reminders:[],lines:[{description:'Frukt och grönt till konferens',quantityMilli:1000,unitPriceOre:1008000,vatBasisPoints:2500,netOre:1008000,vatOre:252000,grossOre:1260000}]},
    {id:'demo-i4',customerId:'cust-demo-4',kind:'customer',customerNumber:'K-1004',customerName:'Majorna Fastigheter AB',invoiceNumber:'310004',ocr:'310004',invoiceDate:'2026-09-05',postingDate:'2026-09-05',dueDate:'2026-09-12',netOre:188000,vatOre:47000,totalOre:235000,remainingOre:0,status:'Betald',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',revenueAccount:'3010',batchNumber:'1031',journalNumber:'K4',customerType:'business',reminderFeeAgreed:true,commentCount:0,comments:[],reminders:[],transactions:[{id:'demo-t2',transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:'2026-09-12',postingDate:'2026-09-12',batchNumber:'1042',journalNumber:'A42',amountOre:-235000,approved:true,account:'1930'}],lines:[{description:'Veckoleverans fastighetskontor',quantityMilli:1000,unitPriceOre:188000,vatBasisPoints:2500,netOre:188000,vatOre:47000,grossOre:235000}]}
  ];

  const initialState={
    version:VERSION,
    asOfDate:AS_OF_DATE,
    customers,
    customerInvoices,
    bankPayments:[
      {id:'bank-demo-1',externalId:'MANUAL-20260917-1001',bookingDate:AS_OF_DATE,valueDate:AS_OF_DATE,amountOre:420000,currency:'SEK',reference:'310001',message:'Faktura 310001',payerName:'Västra Hamnen Logistik AB',payerAccount:'SE12••••1234',status:'unmatched',source:'demo-manual'},
      {id:'bank-demo-2',externalId:'MANUAL-20260917-1002',bookingDate:AS_OF_DATE,valueDate:AS_OF_DATE,amountOre:392500,currency:'SEK',reference:'310002',message:'Slutbetalning faktura 310002',payerName:'Nordic Office Göteborg AB',payerAccount:'SE34••••8821',status:'proposal-created',source:'demo-manual'},
      {id:'bank-demo-3',externalId:'MANUAL-20260917-1003',bookingDate:AS_OF_DATE,valueDate:AS_OF_DATE,amountOre:235000,currency:'SEK',reference:'Betalning september',message:'Tack',payerName:'Okänd betalare',payerAccount:'SE55••••9911',status:'unmatched',source:'demo-manual'}
    ],
    suppliers:[
      {id:'s1',supplierNumber:'L-100',name:'Grön Grossist AB',orgNumber:'559100-1001',email:'ekonomi@grongrossist.example',bankgiro:'555-1234',plusgiro:'',defaultCostAccount:'4010'},
      {id:'s2',supplierNumber:'L-120',name:'Kustens Emballage AB',orgNumber:'559100-1209',email:'faktura@kustemballage.example',bankgiro:'777-4400',plusgiro:'',defaultCostAccount:'5460'},
      {id:'s3',supplierNumber:'L-144',name:'Billdal Kyla & Service AB',orgNumber:'559100-1449',email:'faktura@billdalkyla.example',bankgiro:'333-4411',plusgiro:'',defaultCostAccount:'5510'},
      {id:'s4',supplierNumber:'L-101',name:'Göteborg Fruktlager AB',orgNumber:'559100-1019',email:'ekonomi@fruktlager.example',bankgiro:'444-8821',plusgiro:'',defaultCostAccount:'4010'}
    ],
    supplierPendingChanges:[
      {id:'chg-demo-1',supplierId:'s2',supplierName:'Kustens Emballage AB',supplierNumber:'L-120',kind:'payment-details',status:'pending',requestedBy:'demo-accountant',requestedAt:'2026-09-16T07:45:00.000Z',changes:{bankgiro:'777-4499',plusgiro:''}}
    ],
    supplierHistory:{s1:[{id:'h1',changeType:'profile',changedBy:'demo-accountant',changedAt:'2026-09-15T08:20:00.000Z',before:{defaultCostAccount:'4000'},after:{defaultCostAccount:'4010'}}]},
    supplierInvoices:[
      {id:'sinv-demo-1',supplierId:'s1',supplierName:'Grön Grossist AB',supplierNumber:'L-100',supplierInvoiceNumber:'GG-4401',invoiceDate:'2026-09-10',dueDate:AS_OF_DATE,totalOre:125000,vatOre:25000,currency:'SEK',status:'coded',registeredBy:'demo-registrar',approvedBy:null,hasDocument:true,coding:[{account:'4010',debitOre:100000,creditOre:0,text:'Varuinköp',vatCode:'INPUT_VAT'},{account:'2641',debitOre:25000,creditOre:0,text:'Ingående moms',vatCode:'INPUT_VAT'},{account:'2440',debitOre:0,creditOre:125000,text:'Leverantörsskuld',vatCode:''}]},
      {id:'sinv-demo-2',supplierId:'s2',supplierName:'Kustens Emballage AB',supplierNumber:'L-120',supplierInvoiceNumber:'KE-2088',invoiceDate:'2026-09-12',dueDate:'2026-09-20',totalOre:58900,vatOre:11780,currency:'SEK',status:'registered',registeredBy:'demo-registrar',approvedBy:null,hasDocument:true,coding:[]},
      {id:'sinv-demo-3',supplierId:'s3',supplierName:'Billdal Kyla & Service AB',supplierNumber:'L-144',supplierInvoiceNumber:'BKS-771',invoiceDate:'2026-09-08',dueDate:'2026-09-14',totalOre:437500,vatOre:87500,currency:'SEK',status:'approved',registeredBy:'demo-registrar',approvedBy:'demo-approver',hasDocument:true,coding:[{account:'5510',debitOre:350000,creditOre:0,text:'Reparation och underhåll',vatCode:'INPUT_VAT'},{account:'2641',debitOre:87500,creditOre:0,text:'Ingående moms',vatCode:'INPUT_VAT'},{account:'2440',debitOre:0,creditOre:437500,text:'Leverantörsskuld',vatCode:''}]},
      {id:'sinv-demo-4',supplierId:'s4',supplierName:'Göteborg Fruktlager AB',supplierNumber:'L-101',supplierInvoiceNumber:'GF-8821',invoiceDate:'2026-09-05',dueDate:'2026-09-12',totalOre:84600,vatOre:16920,currency:'SEK',status:'paid',registeredBy:'demo-registrar',approvedBy:'demo-approver',hasDocument:true,liabilityPosted:true,liabilityAccountingEntryId:'e7',openAmountOre:0,coding:[{account:'4010',debitOre:67680,creditOre:0,text:'Varuinköp',vatCode:'INPUT_VAT'},{account:'2641',debitOre:16920,creditOre:0,text:'Ingående moms',vatCode:'INPUT_VAT'},{account:'2440',debitOre:0,creditOre:84600,text:'Leverantörsskuld',vatCode:''}]}
    ],
    supplierPayments:[
      {id:'spay-demo-paid-1',supplierInvoiceId:'sinv-demo-4',paymentDate:'2026-09-12',supplierName:'Göteborg Fruktlager AB',supplierInvoiceNumber:'GF-8821',amountOre:84600,account:'1930',status:'paid',preparedBy:'demo-accountant',releasedBy:'demo-approver',confirmationReference:'DEMO-GF-8821'}
    ],
    documents:[
      {id:'doc-demo-1',title:'Leverantörsfaktura GF-8821',fileName:'GF-8821.pdf',mimeType:'application/pdf',category:'supplier-invoice',sha256:'8f48f53a8d1f61473a09882c66a72f131364157b4c0133c7ce3f4452f46d1911',sizeBytes:184220,uploadedBy:'demo-accountant',createdAt:'2026-09-08T08:20:00Z',links:[{entityType:'supplier-invoice',entityId:'sinv-demo-4',label:'Original'}]},
      {id:'doc-demo-2',title:'Kvitto emballage',fileName:'kvitto-emballage.png',mimeType:'image/png',category:'receipt',sha256:'3b8f2a0d3fbc59790641529f44c2a937144a691816986782084534e9e18c1337',sizeBytes:92840,uploadedBy:'demo-inventory',createdAt:'2026-09-12T13:45:00Z',links:[{entityType:'supplier-invoice',entityId:'sinv-demo-2',label:'Kompletterande underlag'}]},
      {id:'doc-demo-3',title:'Manuellt avstämningsunderlag 17 september',fileName:'avstamning-2026-09-17.pdf',mimeType:'application/pdf',category:'accounting',sha256:'36e2156d594ccf4e57bb500fd477e60ab729151254ac69e3ca9e316118cc79f4',sizeBytes:242110,uploadedBy:'demo-accountant',createdAt:'2026-09-17T07:10:00Z',links:[{entityType:'accounting-period',entityId:'2026-09',label:'Avstämningsunderlag'}]}
    ],
    inventoryItems:[
      {id:'item-apple',sku:'APPLE-SE',name:'Svenska äpplen',unit:'kg',purchaseAccount:'4010',inventoryAccount:'1460',quantityMilli:18500,active:true},
      {id:'item-tomato',sku:'TOMATO',name:'Tomater',unit:'kg',purchaseAccount:'4010',inventoryAccount:'1460',quantityMilli:12250,active:true},
      {id:'item-box',sku:'BOX-L',name:'Papperskasse stor',unit:'st',purchaseAccount:'5460',inventoryAccount:'1460',quantityMilli:42000,active:true}
    ],
    inventoryMovements:[
      {id:'m1',itemId:'item-apple',movementDate:'2026-09-17',type:'receipt',quantityMilli:25000,note:'Morgonleverans'},
      {id:'m2',itemId:'item-apple',movementDate:'2026-09-17',type:'sale',quantityMilli:-5750,note:'Försäljning'},
      {id:'m3',itemId:'item-apple',movementDate:'2026-09-17',type:'waste',quantityMilli:-750,note:'Skadat i låda'}
    ],
    inventoryAdjustments:[
      {id:'adj-demo-1',itemId:'item-tomato',name:'Tomater',unit:'kg',adjustmentDate:'2026-09-17',currentQuantityMilli:12250,countedQuantityMilli:11800,differenceMilli:-450,reason:'Inventeringskontroll',status:'pending',requestedBy:'demo-inventory'}
    ],
    payrollRuns:[
      {id:'pay-demo-1',period:'2026-09',payDate:'2026-09-25',sourceName:'Extern lön september',grossSalaryOre:3000000,withheldTaxOre:900000,employerContributionsOre:942600,netPayOre:2100000,vacationLiabilityChangeOre:240000,status:'validated',journalSha256:'demo',lines:[{account:'7010',text:'Bruttolön',debitOre:3000000,creditOre:0},{account:'7510',text:'Arbetsgivaravgifter',debitOre:942600,creditOre:0},{account:'2920',text:'Semesterlöneskuld förändring',debitOre:240000,creditOre:0},{account:'2710',text:'Personalskatt',debitOre:0,creditOre:900000},{account:'2731',text:'Arbetsgivaravgifter skuld',debitOre:0,creditOre:942600},{account:'2910',text:'Upplupna löner',debitOre:0,creditOre:2100000},{account:'2920',text:'Semesterlöneskuld',debitOre:0,creditOre:240000}]}
    ],
    accountingEntries:[
      {id:'e1',number:'K1',postingDate:'2026-08-18',description:'Kundfaktura 310001 – Västra Hamnen Logistik AB',sourceType:'customer-invoice',sourceId:'demo-i1',lines:[{account:'1510',text:'Kundfordran',debitOre:420000,creditOre:0},{account:'3010',text:'Försäljning',debitOre:0,creditOre:336000},{account:'2611',text:'Utgående moms',debitOre:0,creditOre:84000}]},
      {id:'e2',number:'K2',postingDate:'2026-08-22',description:'Kundfaktura 310002 – Nordic Office Göteborg AB',sourceType:'customer-invoice',sourceId:'demo-i2',lines:[{account:'1510',text:'Kundfordran',debitOre:785000,creditOre:0},{account:'3010',text:'Försäljning',debitOre:0,creditOre:628000},{account:'2611',text:'Utgående moms',debitOre:0,creditOre:157000}]},
      {id:'e3',number:'K3',postingDate:'2026-09-02',description:'Kundfaktura 310003 – Havsbris Konferens AB',sourceType:'customer-invoice',sourceId:'demo-i3',lines:[{account:'1510',text:'Kundfordran',debitOre:1260000,creditOre:0},{account:'3010',text:'Försäljning',debitOre:0,creditOre:1008000},{account:'2611',text:'Utgående moms',debitOre:0,creditOre:252000}]},
      {id:'e4',number:'K4',postingDate:'2026-09-05',description:'Kundfaktura 310004 – Majorna Fastigheter AB',sourceType:'customer-invoice',sourceId:'demo-i4',lines:[{account:'1510',text:'Kundfordran',debitOre:235000,creditOre:0},{account:'3010',text:'Försäljning',debitOre:0,creditOre:188000},{account:'2611',text:'Utgående moms',debitOre:0,creditOre:47000}]},
      {id:'e5',number:'A41',postingDate:'2026-09-10',description:'Delinbetalning kundfaktura 310002',sourceType:'bank-payment',sourceId:'bank-history-310002-1',lines:[{account:'1930',text:'Företagskonto / bank',debitOre:392500,creditOre:0},{account:'1510',text:'Kundfordringar',debitOre:0,creditOre:392500}]},
      {id:'e6',number:'A42',postingDate:'2026-09-12',description:'Kundinbetalning 310004',sourceType:'bank-payment',sourceId:'bank-history-310004-1',lines:[{account:'1930',text:'Företagskonto / bank',debitOre:235000,creditOre:0},{account:'1510',text:'Kundfordringar',debitOre:0,creditOre:235000}]},
      {id:'e7',number:'B17',postingDate:'2026-09-05',description:'Leverantörsfaktura GF-8821 – Göteborg Fruktlager AB',sourceType:'supplier-invoice',sourceId:'sinv-demo-4',lines:[{account:'4010',text:'Varuinköp',debitOre:67680,creditOre:0},{account:'2641',text:'Ingående moms',debitOre:16920,creditOre:0},{account:'2440',text:'Leverantörsskuld',debitOre:0,creditOre:84600}]},
      {id:'e8',number:'B18',postingDate:'2026-09-12',description:'Betalning leverantörsfaktura GF-8821',sourceType:'supplier-payment',sourceId:'spay-demo-paid-1',lines:[{account:'2440',text:'Leverantörsskulder',debitOre:84600,creditOre:0},{account:'1930',text:'Företagskonto / bank',debitOre:0,creditOre:84600}]}
    ],
    accountingPeriods:[
      {period:'2026-08',status:'locked',lockedBy:'demo-controller',lockedAt:'2026-09-05T10:00:00Z'},
      {period:'2026-09',status:'open',lockedBy:null,lockedAt:null}
    ],
    accountingUnlockRequests:[
      {id:'u1',period:'2026-08',reason:'Efterkontroll av felaktigt kostnadskonto',status:'pending',requestedBy:'demo-accountant',requestedAt:'2026-09-16T08:15:00Z'}
    ],
    automationProposals:[
      {id:'demo-p1',type:'bank-payment-match',sourceId:'bank-demo-2',status:'ready-for-approval',confidence:1,deterministic:true,ambiguous:false,reason:'OCR 310002 och exakt restbelopp 3 925,00 kr matchar en enda kundfaktura.',decisionReason:'Deterministiska regler gav en entydig träff. En behörig person ska fortfarande godkänna åtgärden.',evidence:[{kind:'payment-reference',label:'OCR / referens',value:'310002',sourceId:'bank-demo-2'},{kind:'amount',label:'Belopp',value:'3 925,00 kr',sourceId:'bank-demo-2'}],suggestion:{action:'match-customer-payment',bankPaymentId:'bank-demo-2',invoiceId:'demo-i2',invoiceNumber:'310002',customerName:'Nordic Office Göteborg AB',amountOre:392500,bookingDate:AS_OF_DATE,bankAccount:'1930',receivableAccount:'1510'},context:{payerName:'Nordic Office Göteborg AB',reference:'310002',invoiceOptions:[{id:'demo-i2',invoiceNumber:'310002',customerName:'Nordic Office Göteborg AB',remainingOre:392500,dueDate:'2026-09-21'}]},review:{actionKind:'bank-payment-match',actionLabel:'Omför inbetalning till kundfaktura/avi',actionDescription:'Koppla inbetalningen på 3 925,00 kr till kundfaktura/avi 310002 och bokför bank mot kundfordran först efter separat genomförande.',target:{invoiceId:'demo-i2',invoiceNumber:'310002',bankPaymentId:'bank-demo-2'},amountOre:392500,bookingDate:AS_OF_DATE,accountingLines:[{account:'1930',accountName:'Företagskonto / bank',debitOre:392500,creditOre:0,label:'Inbetalning till bank',editable:true},{account:'1510',accountName:'Kundfordringar',debitOre:0,creditOre:392500,label:'Minska kundfordran',editable:true}],editable:{accounts:true,targetInvoice:true}},engine:{kind:'rules',name:'incoming-payment-matcher',version:'2'},createdAt:'2026-09-17T07:20:00.000Z'},
      {id:'demo-p2',type:'supplier-invoice-coding',sourceId:'sinv-demo-2',status:'manual-review',confidence:.78,deterministic:false,ambiguous:true,reason:'Leverantören har standardkonto 5460 men fakturatexten innehåller både emballage och service.',decisionReason:'Underlaget är användbart men behöver mänsklig kontroll av kostnadskontot.',evidence:[{kind:'supplier-default',label:'Leverantörens standardkonto',value:'5460 Förbrukningsmaterial',sourceId:'s2'},{kind:'invoice',label:'Leverantörsfaktura',value:'KE-2088 · 589,00 kr',sourceId:'sinv-demo-2'}],suggestion:{invoiceId:'sinv-demo-2',supplierInvoiceId:'sinv-demo-2',totalOre:58900,vatOre:11780,lines:[{account:'5460',debitOre:47120,creditOre:0,text:'Förbrukningsmaterial'},{account:'2641',debitOre:11780,creditOre:0,text:'Ingående moms'},{account:'2440',debitOre:0,creditOre:58900,text:'Leverantörsskuld'}]},context:{invoiceNumber:'KE-2088',supplierName:'Kustens Emballage AB'},review:{actionKind:'supplier-invoice-coding',actionLabel:'Kontera leverantörsfaktura',actionDescription:'Fördela leverantörsfaktura KE-2088 på kostnad, ingående moms och leverantörsskuld. Kontona kan ändras innan godkännande.',target:{supplierInvoiceId:'sinv-demo-2'},amountOre:58900,bookingDate:'',accountingLines:[{account:'5460',accountName:'Förbrukningsmaterial',debitOre:47120,creditOre:0,label:'Kostnad/inköp',editable:true},{account:'2641',accountName:'Ingående moms',debitOre:11780,creditOre:0,label:'Ingående moms',editable:true},{account:'2440',accountName:'Leverantörsskulder',debitOre:0,creditOre:58900,label:'Leverantörsskuld',editable:true}],editable:{accounts:true,targetInvoice:false}},engine:{kind:'rules',name:'supplier-coding-history',version:'1'},createdAt:'2026-09-17T07:25:00.000Z'},
      {id:'demo-p3',type:'supplier-payment-preparation',sourceId:'sinv-demo-3',status:'ready-for-approval',confidence:.95,deterministic:false,ambiguous:false,reason:'Leverantörsfaktura BKS-771 är attesterad och har verifierade betalningsuppgifter.',decisionReason:'Förslaget får förbereda nästa steg men kan inte skicka pengar till banken.',evidence:[{kind:'invoice',label:'Leverantörsfaktura',value:'Billdal Kyla & Service AB · BKS-771',sourceId:'sinv-demo-3'}],suggestion:{paymentId:'payment-proposal-bks-771',supplierInvoiceId:'sinv-demo-3',amountOre:437500,paymentDate:AS_OF_DATE,liabilityAccount:'2440',bankAccount:'1930'},context:{supplierName:'Billdal Kyla & Service AB',invoiceNumber:'BKS-771'},review:{actionKind:'supplier-payment-preparation',actionLabel:'Förbered utbetalning',actionDescription:'Förbered utbetalning 4 375,00 kr för BKS-771. Ett separat frisläppningssteg krävs fortfarande.',target:{paymentId:'payment-proposal-bks-771',supplierInvoiceId:'sinv-demo-3'},amountOre:437500,bookingDate:AS_OF_DATE,accountingLines:[{account:'2440',accountName:'Leverantörsskulder',debitOre:437500,creditOre:0,label:'Minska leverantörsskuld',editable:true},{account:'1930',accountName:'Företagskonto / bank',debitOre:0,creditOre:437500,label:'Utbetalning från bank',editable:true}],editable:{accounts:true,targetInvoice:false}},engine:{kind:'rules',name:'supplier-payment-preparation',version:'1'},createdAt:'2026-09-17T07:30:00.000Z'}
    ]
  };

  const clone=value=>structuredClone(value);
  function state(){
    try{
      const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
      if(saved&&saved.version===VERSION)return saved;
    }catch{}
    const fresh=clone(initialState);
    localStorage.setItem(STORAGE_KEY,JSON.stringify(fresh));
    return fresh;
  }
  function save(next){const value=clone(next);value.version=VERSION;localStorage.setItem(STORAGE_KEY,JSON.stringify(value));return value}
  function reset(){localStorage.removeItem(STORAGE_KEY);return state()}
  function section(name){return clone(state()[name]??null)}
  function patch(mutator){const next=state();mutator(next);return save(next)}
  function bankMatchProposal(paymentId){
    const current=state();
    const payment=current.bankPayments.find(row=>row.id===paymentId);
    if(!payment)return null;
    const invoice=current.customerInvoices.find(row=>row.remainingOre===payment.amountOre&&(row.ocr===payment.reference||row.invoiceNumber===payment.reference));
    if(!invoice)return null;
    const id=`demo-bank-match-${payment.id}`;
    return {id,type:'bank-payment-match',sourceId:payment.id,status:'ready-for-approval',confidence:1,deterministic:true,ambiguous:false,reason:`Referens ${payment.reference} och exakt restbelopp matchar ${invoice.invoiceNumber}.`,decisionReason:'Deterministiska regler gav en entydig träff. En person ska fortfarande granska förslaget.',evidence:[{kind:'payment-reference',label:'Referens',value:payment.reference,sourceId:payment.id},{kind:'amount',label:'Belopp',value:`${(payment.amountOre/100).toLocaleString('sv-SE',{minimumFractionDigits:2})} kr`,sourceId:payment.id}],suggestion:{action:'match-customer-payment',bankPaymentId:payment.id,invoiceId:invoice.id,invoiceNumber:invoice.invoiceNumber,customerName:invoice.customerName,amountOre:payment.amountOre,bookingDate:payment.bookingDate,bankAccount:'1930',receivableAccount:'1510'},context:{payerName:payment.payerName,reference:payment.reference,invoiceOptions:[{id:invoice.id,invoiceNumber:invoice.invoiceNumber,customerName:invoice.customerName,remainingOre:invoice.remainingOre,dueDate:invoice.dueDate}]},review:{actionKind:'bank-payment-match',actionLabel:'Omför inbetalning till kundfaktura/avi',actionDescription:`Koppla inbetalningen till kundfaktura/avi ${invoice.invoiceNumber} och bokför bank mot kundfordran först efter separat genomförande.`,target:{invoiceId:invoice.id,invoiceNumber:invoice.invoiceNumber,bankPaymentId:payment.id},amountOre:payment.amountOre,bookingDate:payment.bookingDate,accountingLines:[{account:'1930',accountName:'Företagskonto / bank',debitOre:payment.amountOre,creditOre:0,label:'Inbetalning till bank',editable:true},{account:'1510',accountName:'Kundfordringar',debitOre:0,creditOre:payment.amountOre,label:'Minska kundfordran',editable:true}],editable:{accounts:true,targetInvoice:true}},engine:{kind:'rules',name:'incoming-payment-matcher',version:'2'},createdAt:new Date().toISOString()};
  }

  globalThis.RollandsDemoScenario=Object.freeze({VERSION,STORAGE_KEY,AS_OF_DATE,initialState:clone(initialState),state,save,reset,section,patch,bankMatchProposal});
})();
