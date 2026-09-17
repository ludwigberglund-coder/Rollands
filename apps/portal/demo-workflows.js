(function(){
  'use strict';
  const Demo=globalThis.RollandsDemoScenario;
  if(!Demo)return;
  function fail(message,code){const error=new Error(message);error.code=code;throw error}
  function nextNumber(rows,key,prefix,start){const nums=rows.map(r=>Number(String(r[key]||'').replace(/\D/g,''))).filter(Number.isFinite);return String(Math.max(start-1,...nums)+1).padStart(String(start).length,'0')}
  function createCustomer(input={}){
    const name=String(input.name||'').trim(),orgNumber=String(input.orgNumber||'').trim(),email=String(input.email||'').trim();
    if(name.length<2)fail('Kundnamn saknas.','DEMO_CUSTOMER_NAME_REQUIRED');
    if(!email.includes('@'))fail('Ange en giltig e-postadress.','DEMO_CUSTOMER_EMAIL_INVALID');
    let created;
    Demo.patch(state=>{
      const customerNumber=`K-${nextNumber(state.customers,'customerNumber',1001)}`;
      created={id:`cust-demo-${Date.now()}`,customerNumber,name,orgNumber,email,phone:String(input.phone||''),paymentTermsDays:Number(input.paymentTermsDays||30),customerType:'business',reminderFeeAgreed:Boolean(input.reminderFeeAgreed),active:true};
      state.customers.push(created);
    });
    return structuredClone(created);
  }
  function createCustomerInvoice(input={}){
    const customerId=String(input.customerId||''),invoiceDate=String(input.invoiceDate||Demo.AS_OF_DATE),dueDate=String(input.dueDate||''),description=String(input.description||'').trim();
    const quantityMilli=Number(input.quantityMilli||1000),unitPriceOre=Number(input.unitPriceOre||0),vatBasisPoints=Number(input.vatBasisPoints??2500);
    if(!Number.isSafeInteger(quantityMilli)||quantityMilli<=0)fail('Antalet måste vara större än noll.','DEMO_INVOICE_QUANTITY_INVALID');
    if(!Number.isSafeInteger(unitPriceOre)||unitPriceOre<=0)fail('Pris måste vara större än noll.','DEMO_INVOICE_PRICE_INVALID');
    if(!description)fail('Beskrivning saknas.','DEMO_INVOICE_DESCRIPTION_REQUIRED');
    const netOre=Math.round(unitPriceOre*quantityMilli/1000),vatOre=Math.round(netOre*vatBasisPoints/10000),totalOre=netOre+vatOre;
    let created;
    Demo.patch(state=>{
      const customer=state.customers.find(row=>row.id===customerId);if(!customer)fail('Kunden hittades inte.','DEMO_CUSTOMER_NOT_FOUND');
      const invoiceNumber=nextNumber(state.customerInvoices,'invoiceNumber',310001);
      created={id:`demo-i-${Date.now()}`,customerId:customer.id,kind:'customer',customerNumber:customer.customerNumber,customerName:customer.name,invoiceNumber,ocr:invoiceNumber,invoiceDate,postingDate:invoiceDate,dueDate,totalOre,netOre,vatOre,remainingOre:totalOre,status:'Utkast',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',revenueAccount:'3010',batchNumber:'',journalNumber:'',customerType:customer.customerType,reminderFeeAgreed:customer.reminderFeeAgreed,commentCount:0,comments:[],transactions:[],reminders:[],lines:[{description,quantityMilli,unitPriceOre,vatBasisPoints,netOre,vatOre,grossOre:totalOre}]};
      state.customerInvoices.unshift(created);
    });
    return structuredClone(created);
  }
  function postCustomerInvoice(invoiceId){
    Demo.patch(state=>{
      const invoice=state.customerInvoices.find(row=>row.id===invoiceId);if(!invoice)fail('Kundfakturan hittades inte.','DEMO_CUSTOMER_INVOICE_NOT_FOUND');
      if(invoice.status!=='Utkast')return;
      const used=state.accountingEntries.filter(entry=>entry.sourceType==='customer-invoice').length;
      const entry={id:`entry-customer-${invoice.id}`,number:`K${used+1}`,postingDate:invoice.postingDate,description:`Kundfaktura ${invoice.invoiceNumber} – ${invoice.customerName}`,sourceType:'customer-invoice',sourceId:invoice.id,lines:[{account:'1510',text:'Kundfordran',debitOre:invoice.totalOre,creditOre:0},{account:invoice.revenueAccount||'3010',text:'Försäljning',debitOre:0,creditOre:invoice.netOre},{account:'2611',text:'Utgående moms',debitOre:0,creditOre:invoice.vatOre}]};
      state.accountingEntries.unshift(entry);invoice.status='Bokförd';invoice.journalNumber=entry.number;invoice.batchNumber=String(1100+used);invoice.accountingEntryId=entry.id;
    });
    return Demo.state();
  }
  function applyCustomerPayment(paymentId){
    Demo.patch(state=>{
      const payment=state.bankPayments.find(row=>row.id===paymentId);if(!payment)fail('Inbetalningen hittades inte.','DEMO_BANK_PAYMENT_NOT_FOUND');
      if(payment.status==='posted')return;
      const invoice=state.customerInvoices.find(row=>row.remainingOre===payment.amountOre&&(row.invoiceNumber===payment.reference||row.ocr===payment.reference));if(!invoice)fail('Ingen entydig kundfaktura matchar betalningen.','DEMO_CUSTOMER_PAYMENT_NO_MATCH');
      invoice.remainingOre=0;invoice.status='Betald';invoice.transactions.push({id:`demo-t-${Date.now()}`,transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:payment.bookingDate,postingDate:payment.bookingDate,batchNumber:String(1200+state.accountingEntries.length),journalNumber:`A${50+state.accountingEntries.filter(e=>e.sourceType==='bank-payment').length}`,amountOre:-payment.amountOre,approved:true,account:'1930'});payment.status='posted';
      if(!state.accountingEntries.some(entry=>entry.sourceType==='bank-payment'&&entry.sourceId===payment.id))state.accountingEntries.unshift({id:`entry-${payment.id}`,number:`A${50+state.accountingEntries.filter(e=>e.sourceType==='bank-payment').length}`,postingDate:payment.bookingDate,description:`Kundinbetalning ${invoice.invoiceNumber}`,sourceType:'bank-payment',sourceId:payment.id,lines:[{account:'1930',text:'Företagskonto / bank',debitOre:payment.amountOre,creditOre:0},{account:'1510',text:'Kundfordringar',debitOre:0,creditOre:payment.amountOre}]});
    });
    return Demo.state();
  }
  function postSupplierInvoice(invoiceId){
    Demo.patch(state=>{
      const invoice=state.supplierInvoices.find(row=>row.id===invoiceId);
      if(!invoice)fail('Leverantörsfakturan hittades inte.','DEMO_INVOICE_NOT_FOUND');
      if(invoice.liabilityPosted||invoice.liabilityAccountingEntryId)return;
      if(invoice.status!=='approved')fail('Fakturan måste vara attesterad före bokföring.','DEMO_INVOICE_NOT_APPROVED');
      const debit=(invoice.coding||[]).reduce((sum,row)=>sum+Number(row.debitOre||0),0),credit=(invoice.coding||[]).reduce((sum,row)=>sum+Number(row.creditOre||0),0);
      if(debit!==invoice.totalOre||credit!==invoice.totalOre)fail('Konteringen balanserar inte mot fakturabeloppet.','DEMO_INVALID_CODING');
      const liability=(invoice.coding||[]).filter(row=>row.account==='2440').reduce((sum,row)=>sum+Number(row.creditOre||0)-Number(row.debitOre||0),0);
      if(liability!==invoice.totalOre)fail('Konto 2440 stämmer inte med fakturabeloppet.','DEMO_INVALID_LIABILITY');
      const used=state.accountingEntries.filter(entry=>entry.sourceType==='supplier-invoice').length;
      const entry={id:`entry-invoice-${invoice.id}`,number:`B${20+used}`,postingDate:invoice.invoiceDate,description:`Leverantörsfaktura ${invoice.supplierInvoiceNumber} – ${invoice.supplierName}`,sourceType:'supplier-invoice',sourceId:invoice.id,lines:structuredClone(invoice.coding)};
      state.accountingEntries.unshift(entry);invoice.liabilityPosted=true;invoice.liabilityAccountingEntryId=entry.id;invoice.openAmountOre=invoice.totalOre;
    });
    return Demo.state();
  }
  function prepareSupplierPayment(invoiceId){
    Demo.patch(state=>{
      const invoice=state.supplierInvoices.find(row=>row.id===invoiceId);
      if(!invoice)fail('Leverantörsfakturan hittades inte.','DEMO_INVOICE_NOT_FOUND');
      if(invoice.status!=='approved')fail('Fakturan måste vara attesterad före betalningsförberedelse.','DEMO_INVOICE_NOT_APPROVED');
      if(!invoice.liabilityPosted&&!invoice.liabilityAccountingEntryId)fail('Leverantörsskulden måste bokföras före betalningsförberedelse.','DEMO_LIABILITY_NOT_POSTED');
      invoice.status='payment-prepared';
      if(!state.supplierPayments.some(row=>row.supplierInvoiceId===invoice.id&&['prepared','released','paid'].includes(row.status)))state.supplierPayments.push({id:`spay-${invoice.id}`,supplierInvoiceId:invoice.id,paymentDate:Demo.AS_OF_DATE,supplierName:invoice.supplierName,supplierInvoiceNumber:invoice.supplierInvoiceNumber,amountOre:invoice.openAmountOre??invoice.totalOre,account:'1930',status:'prepared',preparedBy:'demo-accountant'});
    });
    return Demo.state();
  }
  function releaseSupplierPayment(paymentId){Demo.patch(state=>{const payment=state.supplierPayments.find(row=>row.id===paymentId);if(!payment)fail('Betalningen hittades inte.','DEMO_PAYMENT_NOT_FOUND');if(payment.status!=='prepared')fail('Endast en förberedd betalning kan frisläppas.','DEMO_PAYMENT_NOT_PREPARED');payment.status='released';payment.releasedBy='demo-approver';payment.releasedAt=new Date().toISOString()});return Demo.state()}
  function confirmSupplierPayment(paymentId,reference=`DEMO-${paymentId}`){
    Demo.patch(state=>{
      const payment=state.supplierPayments.find(row=>row.id===paymentId);if(!payment)fail('Betalningen hittades inte.','DEMO_PAYMENT_NOT_FOUND');if(payment.status==='paid')return;if(payment.status!=='released')fail('Betalningen måste vara frisläppt före bankbekräftelse.','DEMO_PAYMENT_NOT_RELEASED');
      const invoice=state.supplierInvoices.find(row=>row.id===payment.supplierInvoiceId);if(!invoice?.liabilityPosted&&!invoice?.liabilityAccountingEntryId)fail('Leverantörsskulden måste vara bokförd före betalningen.','DEMO_LIABILITY_NOT_POSTED');payment.status='paid';payment.confirmationReference=reference;payment.confirmedAt=new Date().toISOString();if(invoice){invoice.status='paid';invoice.openAmountOre=0}
      if(!state.accountingEntries.some(entry=>entry.sourceType==='supplier-payment'&&entry.sourceId===payment.id)){const used=state.accountingEntries.filter(entry=>entry.sourceType==='supplier-payment').length;state.accountingEntries.unshift({id:`entry-${payment.id}`,number:`A${60+used}`,postingDate:Demo.AS_OF_DATE,description:`Betalning leverantörsfaktura ${payment.supplierInvoiceNumber}`,sourceType:'supplier-payment',sourceId:payment.id,lines:[{account:'2440',text:'Leverantörsskulder',debitOre:payment.amountOre,creditOre:0},{account:payment.account||'1930',text:'Företagskonto / bank',debitOre:0,creditOre:payment.amountOre}]})}
    });return Demo.state();
  }
  globalThis.RollandsDemoWorkflows=Object.freeze({createCustomer,createCustomerInvoice,postCustomerInvoice,applyCustomerPayment,postSupplierInvoice,prepareSupplierPayment,releaseSupplierPayment,confirmSupplierPayment});
})();
