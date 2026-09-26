const app=document.getElementById('portal-app');
const R=window.RollandsReceivables;
const Demo=globalThis.RollandsDemoScenario;
const isPagesDemo=new URLSearchParams(location.search).get('demo')==='1';
const COLUMN_KEY='rollands-portal-receivable-columns-v1';
const COMMENT_KEY='rollands-portal-demo-comments-v1';
const REMINDER_KEY='rollands-portal-demo-reminders-v1';
let mode=isPagesDemo?'demo':(location.hostname==='ludwigberglund-coder.github.io'?'supabase':'api');
let session=null;
let csrfToken=sessionStorage.getItem('rollands-csrf') || '';
let legalRates=null;
let invoices=[];
let receivableCustomers=[];
let receivableSearch='';
let receivableSuggestionsOpen=false;
let receivableSuggestionIndex=-1;
let selectedReceivableCustomerId='';
let selectedReceivableInvoiceId='';
let loginCompanies=[];
let contextMenu=null;
let modal=null;
let feedback='';
let visibleColumns=new Set(loadJson(COLUMN_KEY,R.RECEIVABLE_COLUMNS.filter(c=>c.defaultVisible).map(c=>c.id)));

const demoInvoices=[
  {id:'demo-i1',kind:'customer',customerNumber:'K-1001',customerName:'Västra Hamnen Logistik AB',customerOrgNumber:'111111-1111',invoiceNumber:'310001',ocr:'310001',invoiceDate:'2026-08-18',postingDate:'2026-08-18',dueDate:'2026-09-17',totalOre:420000,remainingOre:420000,vatOre:45000,status:'Förfallen',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',batchNumber:'1028',journalNumber:'A28',customerType:'business',reminderFeeAgreed:true,commentCount:1,transactions:[],reminders:[{id:'demo-r1',sentAt:'2026-09-19T09:00:00.000Z',kind:'payment-reminder'}]},
  {id:'demo-i2',kind:'customer',customerNumber:'K-1002',customerName:'Nordic Office Göteborg AB',customerOrgNumber:'222222-2222',invoiceNumber:'310002',ocr:'310002',invoiceDate:'2026-08-22',postingDate:'2026-08-22',dueDate:'2026-09-21',totalOre:785000,remainingOre:392500,vatOre:157000,status:'Delbetald',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',batchNumber:'1029',journalNumber:'A29',customerType:'business',reminderFeeAgreed:true,commentCount:0,reminders:[],transactions:[{id:'demo-t1',transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:'2026-09-10',postingDate:'2026-09-10',batchNumber:'1041',journalNumber:'A41',amountOre:-392500,approved:true,account:'1930'}]},
  {id:'demo-i3',kind:'customer',customerNumber:'K-1003',customerName:'Havsbris Konferens AB',customerOrgNumber:'333333-3333',invoiceNumber:'310003',ocr:'310003',invoiceDate:'2026-09-02',postingDate:'2026-09-02',dueDate:'2026-10-02',totalOre:1260000,remainingOre:1260000,vatOre:135000,status:'Bokförd',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',batchNumber:'1030',journalNumber:'A30',customerType:'business',reminderFeeAgreed:false,commentCount:0,transactions:[],reminders:[]},
  {id:'demo-i4',kind:'customer',customerNumber:'K-1004',customerName:'Majorna Fastigheter AB',customerOrgNumber:'444444-4444',invoiceNumber:'310004',ocr:'310004',invoiceDate:'2026-09-05',postingDate:'2026-09-05',dueDate:'2026-10-05',totalOre:235000,remainingOre:0,vatOre:47000,status:'Betald',paymentMethod:'Bankgiro',paymentAccount:'BG 123-4567',invoiceAccount:'1510',batchNumber:'1031',journalNumber:'A31',customerType:'business',reminderFeeAgreed:true,commentCount:0,reminders:[],transactions:[{id:'demo-t2',transactionType:'payment',paymentMethod:'Bankgiro',paymentDate:'2026-09-12',postingDate:'2026-09-12',batchNumber:'1042',journalNumber:'A42',amountOre:-235000,approved:true,account:'1930'}]}
].map(invoice=>({
  ...invoice,
  interestStartBasis:'predetermined-due-date',
  interestStartEvidenceSource:'issued-invoice-document',
  interestStartVerifiedAt:(invoice.invoiceDate||invoice.date)+'T09:00:00.000Z'
}));

function loadJson(key,fallback){try{const value=JSON.parse(localStorage.getItem(key));return value ?? fallback}catch{return fallback}}
function saveJson(key,value){localStorage.setItem(key,JSON.stringify(value))}
function escapeHtml(value=''){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function ore(value){if(value==null||value==='')return '—';return new Intl.NumberFormat('sv-SE',{style:'currency',currency:'SEK',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)/100)}
function shortDate(value){return value?String(value).slice(0,10):'—'}
function initials(name){return String(name||'Demo').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()}
function today(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function dueClass(invoice){return invoice.remainingOre>0 && invoice.dueDate<today()?'overdue':''}
function normalizeSearch(value){return String(value||'').trim().toLocaleLowerCase('sv-SE')}
function invoicesForCustomer(customerId){return invoices.filter(invoice=>String(invoice.customerId||'')===String(customerId||''))}
function customerSummary(customerId){
  const stored=receivableCustomers.find(customer=>String(customer.customerId)===String(customerId));
  if(stored)return stored;
  const list=invoicesForCustomer(customerId);
  const first=list[0]||{};
  return{customerId,customerNumber:first.customerNumber||'',customerName:first.customerName||'',orgNumber:first.customerOrgNumber||'',invoiceCount:list.length,openInvoiceCount:list.filter(i=>Number(i.remainingOre)!==0).length,remainingOre:list.reduce((sum,i)=>sum+Number(i.remainingOre||0),0)};
}
function matchRank(value,query){
  const text=normalizeSearch(value);
  if(!text||!query)return Number.POSITIVE_INFINITY;
  if(text===query)return 0;
  if(text.startsWith(query))return 1;
  if(text.split(/[^a-z0-9åäö]+/i).some(part=>part.startsWith(query)))return 2;
  if(text.includes(query))return 3;
  return Number.POSITIVE_INFINITY;
}
function receivableSearchSuggestionData(){
  const query=normalizeSearch(receivableSearch);
  if(!query)return{customers:[],invoices:[]};
  const customers=receivableCustomers.map(customer=>{
    const rank=Math.min(
      matchRank(customer.customerName,query),
      matchRank(customer.customerNumber,query),
      matchRank(customer.orgNumber,query)
    );
    return{customer,rank};
  }).filter(item=>Number.isFinite(item.rank))
    .sort((a,b)=>a.rank-b.rank||String(a.customer.customerName||'').localeCompare(String(b.customer.customerName||''),'sv'));
  const invoicesFound=invoices.map(invoice=>{
    const customer=customerSummary(invoice.customerId);
    const directRank=Math.min(matchRank(invoice.invoiceNumber,query),matchRank(invoice.ocr,query));
    const customerRank=Math.min(
      matchRank(customer.customerName,query),
      matchRank(customer.customerNumber,query),
      matchRank(customer.orgNumber,query)
    );
    const rank=Math.min(directRank,Number.isFinite(customerRank)?customerRank+4:Number.POSITIVE_INFINITY);
    return{invoice,customer,rank};
  }).filter(item=>Number.isFinite(item.rank))
    .sort((a,b)=>a.rank-b.rank||String(a.invoice.invoiceNumber||'').localeCompare(String(b.invoice.invoiceNumber||''),'sv'));
  return{customers,invoices:invoicesFound};
}
function matchingCustomerIds(){
  if(selectedReceivableCustomerId)return new Set([selectedReceivableCustomerId]);
  const query=normalizeSearch(receivableSearch);
  if(!query)return new Set(receivableCustomers.map(customer=>String(customer.customerId)));
  const matches=new Set();
  for(const customer of receivableCustomers){
    if(R.customerMatchesReceivableSearch(customer,invoicesForCustomer(customer.customerId),query))matches.add(String(customer.customerId));
  }
  return matches;
}
function visibleReceivableCustomers(){const ids=matchingCustomerIds();return receivableCustomers.filter(customer=>ids.has(String(customer.customerId)))}
function visibleReceivableInvoices(){const ids=matchingCustomerIds();return invoices.filter(invoice=>ids.has(String(invoice.customerId)))}
function apiUrl(path){return `/api/v1${path}`}

async function supabaseContext(){return window.LTSupabaseUat.context()}
function supabaseRows(table,token,filters=''){return window.LTSupabase.from(table,token).select('*',filters)}

async function api(path,options={}){
  const headers={'Accept':'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})};
  if(options.method && options.method!=='GET' && csrfToken)headers['X-CSRF-Token']=csrfToken;
  const response=await fetch(apiUrl(path),{credentials:'same-origin',...options,headers,body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||'Begäran misslyckades.');error.status=response.status;error.code=data.code;error.data=data;throw error}
  return data;
}

function demoComments(invoiceId){const all=loadJson(COMMENT_KEY,{});return all[invoiceId]||[]}
function setDemoComments(invoiceId,comments){const all=loadJson(COMMENT_KEY,{});all[invoiceId]=comments;saveJson(COMMENT_KEY,all)}
function demoReminders(invoiceId){const all=loadJson(REMINDER_KEY,{});return all[invoiceId]||[]}
function setDemoReminders(invoiceId,reminders){const all=loadJson(REMINDER_KEY,{});all[invoiceId]=reminders;saveJson(REMINDER_KEY,all)}
function invoiceById(id){return invoices.find(invoice=>invoice.id===id)}
function withDemoState(invoice){if(mode!=='demo')return invoice;const comments=demoComments(invoice.id);const savedReminders=demoReminders(invoice.id);return {...invoice,commentCount:Math.max(invoice.commentCount||0,comments.length),reminders:[...(invoice.reminders||[]),...savedReminders]}}

function loginView(error=''){
  const companyField=loginCompanies.length?`<label class="field">Företag<select name="companyId" required><option value="">Välj företag</option>${loginCompanies.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select></label>`:'';
  const identityLabel=mode==='supabase'?'E-post':'Användarnamn eller e-post';
  const identityType=mode==='supabase'?'email':'text';
  app.innerHTML=`<div class="login-shell"><section class="login-brand"><span class="eyebrow">LT Studio</span><h1>Ett arbetsflöde.<br>Hela företaget.</h1><p>Den privata portalen kräver ett personligt konto. Aktivt företagsmedlemskap och företagstillhörighet kontrolleras på servern vid varje skyddad åtgärd.</p></section><section class="login-panel"><form class="login-card" id="login-form"><span class="eyebrow">Privat företagsportal</span><h2>Logga in</h2><p>Administrationsdelen är skild från den publika hemsidan.</p><label class="field">${identityLabel}<input name="username" type="${identityType}" autocomplete="username" required></label><label class="field">Lösenord<input name="password" type="password" autocomplete="current-password" required></label><label class="field">MFA-kod <span style="font-weight:400;color:#69766f">(obligatorisk i Supabase-UAT)</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label>${companyField}<p class="form-error">${escapeHtml(error)}</p><button class="button" type="submit">Logga in säkert</button>${mode==='supabase'?'<p style="margin-top:14px"><a class="button ghost" href="./uat-setup.html">Aktivera UAT-konto / slutför MFA</a></p>':''}</form></section></div>`;
}

function sidebar(){return `<aside class="sidebar"><div class="logo"><strong>${escapeHtml(session?.company?.name||'Företaget')}</strong><small>LT STUDIO</small></div><div class="company-pill">${escapeHtml(session?.company?.name||'Företaget')}<br>${mode==='demo'?'Demoföretag':'Skyddad företagsmiljö'}</div><div class="side-group"><span>Arbetsyta</span><button class="side-link disabled">Översikt</button></div><div class="side-group"><span>Försäljning</span><button class="side-link active">Kundreskontra</button><button class="side-link disabled">Kundfakturor</button><button class="side-link disabled">Kunder</button></div><div class="side-group"><span>Ekonomi</span><button class="side-link disabled">Bank & avstämning</button><button class="side-link disabled">Bokföring</button><button class="side-link disabled">Rapporter</button></div><div class="sidebar-footer">${mode==='demo'?'Öppen GitHub Pages-demo. Inga riktiga företagsuppgifter får användas här.':'Servervaliderad session · default deny'}</div></aside>`}

function metricValues(){
  const list=visibleReceivableInvoices().map(withDemoState),open=list.filter(i=>i.remainingOre>0),overdue=open.filter(i=>i.dueDate<today());
  return{
    total:ore(list.reduce((n,i)=>n+Number(i.remainingOre||0),0)),
    overdue:ore(overdue.reduce((n,i)=>n+Number(i.remainingOre||0),0)),
    open:String(open.length),
    comments:String(list.reduce((sum,i)=>sum+Number(i.commentCount||0),0))
  };
}
function metrics(){
  const value=metricValues();
  return `<section class="metrics"><article class="metric"><span>Totalt kundsaldo</span><strong id="receivable-total-balance">${value.total}</strong></article><article class="metric"><span>Förfallet</span><strong id="receivable-overdue-balance">${value.overdue}</strong></article><article class="metric"><span>Öppna fakturor</span><strong id="receivable-open-count">${value.open}</strong></article><article class="metric"><span>Interna kommentarer</span><strong id="receivable-comment-count">${value.comments}</strong></article></section>`;
}

function columnPicker(){return `<details class="column-picker"><summary>☷ Välj kolumner</summary><div class="column-menu">${R.RECEIVABLE_COLUMNS.map(column=>`<label><input type="checkbox" data-column="${escapeHtml(column.id)}" ${visibleColumns.has(column.id)?'checked':''}>${escapeHtml(column.label)}</label>`).join('')}<button class="button ghost small" data-action="reset-columns" type="button">Återställ alla</button></div></details>`}

function cell(column,row){let value=row[column.id];if(column.money)return `<td class="money">${ore(value)}</td>`;if(column.id==='dueDate')return `<td class="${row.remainingOre>0&&value<today()?'overdue':''}">${escapeHtml(shortDate(value))}</td>`;return `<td>${escapeHtml(value==null||value===''?'—':value)}</td>`}
function mappedTransaction(transaction){const bookingType=transaction.transactionType==='payment'?'Inbetalning':transaction.transactionType==='refund'?'Återbetalning':transaction.transactionType;return {...transaction,type:transaction.transactionType==='payment'?'payment':transaction.transactionType,method:transaction.paymentMethod,date:transaction.paymentDate,postingDate:transaction.postingDate,batch:transaction.batchNumber,transactionNumber:transaction.journalNumber,bookingType,amountOre:transaction.amountOre}}

function customerOverview(){
  const ids=matchingCustomerIds(),active=selectedReceivableCustomerId;
  const cards=receivableCustomers.map(customer=>{
    const visible=ids.has(String(customer.customerId));
    return `<button type="button" class="receivable-customer-card ${String(customer.customerId)===String(active)?'active':''}" data-action="filter-customer" data-customer-id="${escapeHtml(customer.customerId)}" ${visible?'':'hidden'}><span class="receivable-customer-main"><b>${escapeHtml(customer.customerName||'Okänd kund')}</b><small>${escapeHtml(customer.customerNumber||'—')}${customer.orgNumber?` · ${escapeHtml(customer.orgNumber)}`:''}</small></span><span class="receivable-customer-balance"><small>Restbelopp</small><strong>${ore(customer.remainingOre)}</strong><em>${Number(customer.openInvoiceCount||0)} öppna</em></span></button>`;
  }).join('');
  const visibleCount=receivableCustomers.filter(customer=>ids.has(String(customer.customerId))).length;
  return `<section class="receivable-overview panel"><div class="receivable-overview-head"><div><span class="eyebrow">Kundöversikt</span><h3>Alla kunder</h3><p>Kundidentiteten hämtas från Kunder. Fakturor används endast för saldo och för att hitta vilken kund ett fakturanummer tillhör.</p></div><span id="receivable-customer-count" class="receivable-count">${visibleCount} av ${receivableCustomers.length} kunder</span></div><div class="receivable-customer-grid">${cards}<p id="receivable-customers-empty" class="empty" ${visibleCount?'hidden':''}>Ingen kund matchar sökningen.</p></div></section>`;
}
function receivableSearchSuggestionsHtml(){
  const query=normalizeSearch(receivableSearch);
  if(!query||!receivableSuggestionsOpen)return'';
  const {customers,invoices:invoiceMatches}=receivableSearchSuggestionData();
  let optionIndex=0;
  const customerOptions=customers.map(({customer})=>{
    const index=optionIndex++;
    return `<button id="receivable-search-option-${index}" class="receivable-search-option" role="option" aria-selected="${index===receivableSuggestionIndex}" style="--result-index:${index}" data-action="select-receivable-search" data-kind="customer" data-customer-id="${escapeHtml(customer.customerId)}" data-search-value="${escapeHtml(customer.customerName||customer.customerNumber||'')}"><span class="receivable-search-option-type">Kund</span><span class="receivable-search-option-main"><b>${escapeHtml(customer.customerName||'Okänd kund')}</b><small>Kundnr ${escapeHtml(customer.customerNumber||'—')}${customer.orgNumber?` · Org.nr ${escapeHtml(customer.orgNumber)}`:''}</small></span><span class="receivable-search-option-meta">${Number(customer.openInvoiceCount||0)} öppna</span></button>`;
  }).join('');
  const invoiceOptions=invoiceMatches.map(({invoice,customer})=>{
    const index=optionIndex++;
    return `<button id="receivable-search-option-${index}" class="receivable-search-option" role="option" aria-selected="${index===receivableSuggestionIndex}" style="--result-index:${index}" data-action="select-receivable-search" data-kind="invoice" data-customer-id="${escapeHtml(invoice.customerId||'')}" data-invoice-id="${escapeHtml(invoice.id)}" data-search-value="${escapeHtml(invoice.invoiceNumber||'')}"><span class="receivable-search-option-type">Faktura</span><span class="receivable-search-option-main"><b>Faktura ${escapeHtml(invoice.invoiceNumber||'—')}</b><small>${escapeHtml(customer.customerName||'Okänd kund')} · Kundnr ${escapeHtml(customer.customerNumber||'—')}</small></span><span class="receivable-search-option-meta">${ore(invoice.remainingOre)}</span></button>`;
  }).join('');
  if(!customerOptions&&!invoiceOptions)return'<div class="receivable-search-no-results">Ingen kund eller faktura matchar sökningen.</div>';
  return `${customerOptions?`<div class="receivable-search-group-label">Kunder</div>${customerOptions}`:''}${invoiceOptions?`<div class="receivable-search-group-label">Fakturor</div>${invoiceOptions}`:''}`;
}
function receivableSearchBar(){
  const filtered=Boolean(normalizeSearch(receivableSearch)||selectedReceivableCustomerId);
  return `<section class="receivable-search panel"><div class="receivable-search-field"><label for="receivable-search-input"><span>Sök kundreskontra</span><input id="receivable-search-input" type="search" role="combobox" aria-autocomplete="list" aria-controls="receivable-search-results" aria-expanded="${Boolean(normalizeSearch(receivableSearch)&&receivableSuggestionsOpen)}" autocomplete="off" value="${escapeHtml(receivableSearch)}" placeholder="Sök på kund, kundnummer, organisationsnummer eller fakturanummer"></label><div id="receivable-search-results" class="receivable-search-results" role="listbox" ${normalizeSearch(receivableSearch)&&receivableSuggestionsOpen?'':'hidden'}>${receivableSearchSuggestionsHtml()}</div></div><button id="clear-receivable-filter" class="button ghost small ${filtered?'':'is-hidden'}" type="button" data-action="clear-receivable-filter">Visa alla kunder</button></section>`;
}
function reminderRow(invoice,reminder,columns,visible=true){
  const reminderNumber=reminder.reminderNumber||'Äldre påminnelse';
  const reminderChargeOre=Number(reminder.reminderFeeOre||0)+Number(reminder.interestOre||0)+Number(reminder.businessCompensationOre||reminder.businessLatePaymentCompensationOre||0);
  const row={
    period:String(reminder.reminderDate||'').slice(0,7),
    aviType:'Betalningspåminnelse',
    paymentMethod:invoice.paymentMethod||'Bankgiro',
    paymentAccount:invoice.paymentAccount||'',
    invoiceNumber:reminderNumber,
    invoicePostingDate:reminder.reminderDate||'',
    invoiceAmountOre:reminderChargeOre,
    dueDate:invoice.dueDate||'',
    latestReminderDate:reminder.reminderDate||'',
    invoiceAccount:'',
    batchNumber:'',
    paymentDate:'',
    transactionPostingDate:reminder.reminderDate||'',
    bookingType:'Påminnelse',
    transactionNumber:'',
    transactionAmountOre:reminderChargeOre,
    transactionApproved:'Ja',
    transactionAccount:'',
    remainingOre:reminderChargeOre
  };
  const pdf=reminder.pdfSha256?`<a class="button ghost small reminder-pdf-link" href="/api/v1/invoices/${encodeURIComponent(invoice.id)}/reminders/${encodeURIComponent(reminder.id)}/pdf" target="_blank" rel="noopener">Visa PDF</a>`:'';
  const detail=[reminder.reminderFeeOre?`Påminnelseavgift ${ore(reminder.reminderFeeOre)}`:'',reminder.interestOre?`Ränta ${ore(reminder.interestOre)}`:'',Number(reminder.businessCompensationOre||reminder.businessLatePaymentCompensationOre||0)?`Förseningsersättning ${ore(reminder.businessCompensationOre||reminder.businessLatePaymentCompensationOre)}`:''].filter(Boolean).join(' · ');
  return `<tr class="reminder-row" data-reminder-id="${escapeHtml(reminder.id)}" data-customer-id="${escapeHtml(invoice.customerId||'')}" ${visible?'':'hidden'}><td class="customer-cell"><div class="reminder-cell"><span><b>↳ Betalningspåminnelse</b><strong>${escapeHtml(reminderNumber)}</strong><small>Avser faktura ${escapeHtml(invoice.invoiceNumber||'—')}${detail?` · ${escapeHtml(detail)}`:''}</small></span><span class="reminder-actions"><small>Påminnelsebelopp</small><b>${ore(reminderChargeOre)}</b>${pdf}</span></div></td>${columns.map(column=>cell(column,row)).join('')}</tr>`;
}
function table(){
  const columns=R.RECEIVABLE_COLUMNS.filter(column=>visibleColumns.has(column.id)),ids=matchingCustomerIds();
  const head=columns.map(c=>`<th>${escapeHtml(c.label)}</th>`).join('');
  const bodies=invoices.map(rawInvoice=>{
    const invoice=withDemoState(rawInvoice),visible=ids.has(String(invoice.customerId)),hidden=visible?'':'hidden';
    const customer=customerSummary(invoice.customerId),base=R.receivableRow(invoice),comments=invoice.commentCount||0,invoiceRest=Number(invoice.remainingOre||0);
    const refundBadge=invoice.credit?.refundStatus==='pending'?`<span class="comment-badge">Återbetalning väntar · ${ore(invoice.credit.refundOutstandingOre)}</span>`:invoice.credit?.refundStatus==='refunded'?'<span class="comment-badge">Återbetalad</span>':'';
    const invoiceRow=`<tr class="invoice-row" data-invoice-id="${escapeHtml(invoice.id)}" data-customer-id="${escapeHtml(invoice.customerId||'')}" ${hidden}><td class="customer-cell"><div class="customer-identity invoice-customer-identity"><span><b>${escapeHtml(customer.customerNumber||'—')}</b><strong>${escapeHtml(customer.customerName||'Okänd kund')}</strong>${customer.orgNumber?`<small>Org.nr ${escapeHtml(customer.orgNumber)}</small>`:''}</span><span class="invoice-rest-badge"><small>Restbelopp</small><b>${ore(invoiceRest)}</b></span></div>${comments?`<span class="comment-badge">💬 ${comments}</span>`:''}${refundBadge}</td>${columns.map(c=>cell(c,base)).join('')}</tr>`;
    const reminderRows=(invoice.reminders||[]).map(reminder=>reminderRow(invoice,reminder,columns,visible)).join('');
    const txRows=(invoice.transactions||[]).map(tx=>{const row=R.receivableRow(invoice,mappedTransaction(tx));return `<tr class="transaction-row" data-customer-id="${escapeHtml(invoice.customerId||'')}" ${hidden}><td class="customer-cell"><span>↳ transaktion</span></td>${columns.map(c=>cell(c,row)).join('')}</tr>`}).join('');
    return invoiceRow+reminderRows+txRows;
  }).join('');
  const visibleCount=invoices.filter(invoice=>ids.has(String(invoice.customerId))).length;
  return `<div class="table-scroll"><table class="res-table"><thead><tr><th class="customer-cell">Kund</th>${head}</tr></thead><tbody>${bodies}<tr id="receivable-table-empty" ${visibleCount?'hidden':''}><td colspan="${columns.length+1}" class="empty">Ingen kundreskontra matchar sökningen.</td></tr></tbody></table></div>`;
}
function contextHtml(){
  if(!contextMenu)return '';
  const invoice=invoiceById(contextMenu.invoiceId),hasComments=Number(invoice?.commentCount||0)>0;
  const canRemind=Number(invoice?.totalOre||0)>0&&Number(invoice?.remainingOre||0)>0;
  const canRefund=invoice?.credit?.refundStatus==='pending'&&Number(invoice.credit.refundOutstandingOre||0)>0;
  return `<div class="context-menu" style="left:${contextMenu.x}px;top:${contextMenu.y}px">${hasComments?`<button data-action="show-comments" data-id="${escapeHtml(contextMenu.invoiceId)}">Visa kommentar</button>`:''}<button data-action="comment" data-id="${escapeHtml(contextMenu.invoiceId)}">Skriv kommentar</button>${canRemind?`<button data-action="reminder" data-id="${escapeHtml(contextMenu.invoiceId)}">Skapa betalningspåminnelse</button>`:''}${canRefund?`<button data-action="refund" data-id="${escapeHtml(contextMenu.invoiceId)}">Registrera återbetalning</button>`:''}<button data-action="close-context">Avbryt</button></div>`;
}

function commentsModal(){
  const invoice=invoiceById(modal.invoiceId),list=modal.comments||[],compose=modal.compose===true;
  const composer=compose?`<form data-form="comment"><label class="field">Ny kommentar<textarea id="invoice-comment-draft" name="text" maxlength="2000" rows="4" required placeholder="Skriv vad andra behöriga användare behöver känna till…">${escapeHtml(modal.draftText||'')}</textarea></label><p class="form-error"></p><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Avbryt</button><button class="button" type="submit">Spara kommentar</button></div></form>`:`<div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Stäng</button><button type="button" class="button" data-action="new-comment">Skriv ny kommentar</button></div>`;
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" data-stop><header class="modal-head"><div><span class="eyebrow">${escapeHtml(invoice?.invoiceNumber||'Faktura')}</span><h3>${compose?'Skriv fakturakommentar':'Visa kommentar'}</h3></div><button data-action="close-modal" aria-label="Stäng">×</button></header><div class="modal-body"><div class="notice">Kommentarer är interna och visas endast för behöriga användare i samma företag.</div><div class="comments">${list.map(c=>`<article class="comment"><p>${escapeHtml(c.text)}</p><small>${escapeHtml(c.authorName)} · ${escapeHtml(new Date(c.createdAt).toLocaleString('sv-SE'))}</small></article>`).join('')||'<p class="empty">Ingen kommentar ännu.</p>'}</div>${composer}</div></section></div>`;
}

function reminderBreakdown(preview){if(!preview)return '<p class="notice warning">Välj datum och inställningar och klicka på Beräkna innan påminnelsen registreras.</p>';return `<div class="reminder-summary"><span>Utestående kapital</span><strong>${ore(preview.principalOre)}</strong><span>Dröjsmålsränta</span><strong>${ore(preview.interestOre)}</strong><span>Påminnelseavgift</span><strong>${ore(preview.reminderFeeOre)}</strong><span>Förseningsersättning</span><strong>${ore(preview.businessLatePaymentCompensationOre)}</strong><span>Totalt enligt underlaget</span><strong>${ore(preview.totalDueOre)}</strong><span>Årsränta vid påminnelsedatum</span><strong>${(preview.statutoryRateOnSentDateBasisPoints/100).toFixed(2).replace('.',',')} %</strong></div>`}
function reminderModal(){
  const invoice=invoiceById(modal.invoiceId),canFee=Boolean(invoice?.reminderFeeAgreed);
  const values=modal.formValues||{sentDate:modal.sentDate||today(),includeInterest:true,includeReminderFee:false,includeBusinessLatePaymentCompensation:false,note:''};
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" data-stop><header class="modal-head"><div><span class="eyebrow">${escapeHtml(invoice?.invoiceNumber||'Faktura')}</span><h3>Betalningspåminnelse</h3></div><button data-action="close-modal">×</button></header><div class="modal-body"><div class="notice">Påminnelsen blir en egen underpost till originalfakturan och får ett eget påminnelsenummer samt en utskriftsbar PDF. Dokumentet märks tydligt som betalningspåminnelse och refererar alltid originalfakturan.</div><form data-form="reminder"><label class="field">Påminnelsedatum<input name="sentDate" type="date" value="${escapeHtml(values.sentDate||today())}" required></label><label class="field"><span><input name="includeInterest" type="checkbox" ${values.includeInterest!==false?'checked':''}> Beräkna dröjsmålsränta</span></label><label class="field"><span><input name="includeReminderFee" type="checkbox" ${values.includeReminderFee?'checked':''} ${canFee?'':'disabled'}> Lägg till påminnelseavgift 60 kr ${canFee?'':'(inte avtalad för denna kund)'}</span></label><label class="field"><span><input name="includeBusinessLatePaymentCompensation" type="checkbox" ${values.includeBusinessLatePaymentCompensation?'checked':''}> Lägg till förseningsersättning 450 kr vid B2B-eskalering</span></label><label class="field">Anteckning<textarea name="note" maxlength="1000" rows="3">${escapeHtml(values.note||'')}</textarea></label>${reminderBreakdown(modal.preview)}<p class="form-error">${escapeHtml(modal.error||'')}</p><div class="modal-actions"><button type="button" class="button ghost" data-action="preview-reminder">Beräkna</button><button class="button" type="submit" ${modal.preview?'':'disabled'}>Registrera påminnelse</button></div></form></div></section></div>`;
}
function refundModal(){
  const invoice=invoiceById(modal.invoiceId),credit=invoice?.credit||{},outstanding=Number(credit.refundOutstandingOre||0);
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" data-stop><header class="modal-head"><div><span class="eyebrow">Kreditfaktura ${escapeHtml(invoice?.invoiceNumber||'')}</span><h3>Registrera återbetalning</h3></div><button data-action="close-modal" aria-label="Stäng">×</button></header><div class="modal-body"><div class="notice warning">Registrera bara återbetalningen när pengarna faktiskt har betalats ut från banken. Då bokförs återbetalningen och kreditfakturan prickas av.</div><form data-form="refund"><div class="reminder-summary"><span>Återstår att återbetala</span><strong>${ore(outstanding)}</strong><span>Kund</span><strong>${escapeHtml(invoice?.customerName||'—')}</strong></div><label class="field">Bankkonto<select name="refundAccount" required><option value="1930">1930 · Företagskonto/checkkonto</option><option value="1920">1920 · PlusGiro</option><option value="1940">1940 · Övriga bankkonton</option></select></label><label class="field">Återbetalningsdatum<input name="refundDate" type="date" value="${today()}" required></label><label class="field">Bankens referens / transaktions-id<input name="bankReference" minlength="4" maxlength="120" value="KREDIT-${escapeHtml(invoice?.invoiceNumber||'')}" required></label><p class="form-error">${escapeHtml(modal.error||'')}</p><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Avbryt</button><button type="submit" class="button">Registrera & bokför återbetalning</button></div></form></div></section></div>`;
}
function modalHtml(){if(!modal)return '';if(modal.type==='comments')return commentsModal();if(modal.type==='reminder')return reminderModal();if(modal.type==='refund')return refundModal();return ''}

function syncSearchControls(){
  const input=document.getElementById('receivable-search-input');
  if(input&&input.value!==receivableSearch)input.value=receivableSearch;
  if(input){
    input.setAttribute('aria-expanded',String(Boolean(normalizeSearch(receivableSearch)&&receivableSuggestionsOpen)));
    if(receivableSuggestionIndex>=0)input.setAttribute('aria-activedescendant','receivable-search-option-'+receivableSuggestionIndex);
    else input.removeAttribute('aria-activedescendant');
  }
  const clear=document.getElementById('clear-receivable-filter');
  if(clear)clear.classList.toggle('is-hidden',!(normalizeSearch(receivableSearch)||selectedReceivableCustomerId));
}
function renderReceivableSearchSuggestions(){
  const host=document.getElementById('receivable-search-results');
  if(!host)return;
  const visible=Boolean(normalizeSearch(receivableSearch)&&receivableSuggestionsOpen);
  host.hidden=!visible;
  host.innerHTML=visible?receivableSearchSuggestionsHtml():'';
  syncSearchControls();
  if(visible){
    const active=host.querySelector('[aria-selected="true"]');
    active?.scrollIntoView?.({block:'nearest'});
  }
}
function searchSuggestionButtons(){return[...document.querySelectorAll('#receivable-search-results .receivable-search-option')]}
function moveReceivableSuggestion(delta){
  const buttons=searchSuggestionButtons();
  if(!buttons.length){receivableSuggestionIndex=-1;syncSearchControls();return}
  receivableSuggestionIndex=(receivableSuggestionIndex+delta+buttons.length)%buttons.length;
  buttons.forEach((button,index)=>{
    const active=index===receivableSuggestionIndex;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
  });
  syncSearchControls();
  buttons[receivableSuggestionIndex]?.scrollIntoView?.({block:'nearest'});
}
function updateReceivableMetricsDom(){
  const value=metricValues(),pairs=[['receivable-total-balance',value.total],['receivable-overdue-balance',value.overdue],['receivable-open-count',value.open],['receivable-comment-count',value.comments]];
  for(const [id,textValue] of pairs){const node=document.getElementById(id);if(node)node.textContent=textValue}
}
function applyReceivableFilterDom(){
  const ids=matchingCustomerIds();
  let customerCount=0,invoiceCount=0;
  for(const card of document.querySelectorAll('.receivable-customer-card[data-customer-id]')){
    const visible=ids.has(String(card.dataset.customerId||''));card.hidden=!visible;if(visible)customerCount+=1;
    card.classList.toggle('active',String(card.dataset.customerId||'')===String(selectedReceivableCustomerId||''));
  }
  for(const row of document.querySelectorAll('.invoice-row[data-customer-id],.reminder-row[data-customer-id],.transaction-row[data-customer-id]')){
    const visible=ids.has(String(row.dataset.customerId||''));row.hidden=!visible;
    if(visible&&row.classList.contains('invoice-row'))invoiceCount+=1;
  }
  const customerCountNode=document.getElementById('receivable-customer-count');
  if(customerCountNode)customerCountNode.textContent=customerCount+' av '+receivableCustomers.length+' kunder';
  const customersEmpty=document.getElementById('receivable-customers-empty');
  if(customersEmpty)customersEmpty.hidden=customerCount>0;
  const tableEmpty=document.getElementById('receivable-table-empty');
  if(tableEmpty)tableEmpty.hidden=invoiceCount>0;
  for(const row of document.querySelectorAll('.invoice-row[data-invoice-id]')){
    row.classList.toggle('search-selected',Boolean(selectedReceivableInvoiceId)&&row.dataset.invoiceId===selectedReceivableInvoiceId);
  }
  updateReceivableMetricsDom();syncSearchControls();
}
function renderReceivableResults(){
  const overview=document.getElementById('receivable-overview-region'),metricRegion=document.getElementById('receivable-metrics-region'),tableRegion=document.getElementById('receivable-table-region');
  if(overview)overview.innerHTML=customerOverview();
  if(metricRegion)metricRegion.innerHTML=metrics();
  if(tableRegion)tableRegion.innerHTML=table();
  renderReceivableSearchSuggestions();
  syncSearchControls();
}
function renderOverlays(){
  const host=document.getElementById('portal-overlays');
  if(host)host.innerHTML=contextHtml()+modalHtml();
}
function portalView(){
  const userName=session?.user?.displayName || 'Demoanvändare';
  app.innerHTML=`<div class="portal">${sidebar()}<section class="main"><header class="topbar"><div><h1>Kundreskontra</h1><p>${escapeHtml(session?.company?.name||'Företaget')} / Försäljning / Kundreskontra</p></div><div class="user-chip"><div><b>${escapeHtml(userName)}</b><br><small>${mode==='demo'?'Demo':'Inloggad'}</small></div><div class="avatar">${escapeHtml(initials(userName))}</div>${mode==='api'?'<button class="button ghost small" data-action="logout">Logga ut</button>':''}</div></header><main class="content">${mode==='demo'?'<div class="demo-banner"><b>GitHub Pages-demo.</b> Kommentarer och kolumnval sparas bara i din webbläsare. Riktiga företagsuppgifter ska aldrig användas här.</div>':''}${feedback?`<div class="notice">${escapeHtml(feedback)}</div>`:''}<div class="page-heading"><div><span class="eyebrow">Kundfordringar</span><h2>Saldo, inbetalningar och avprickning</h2><p>Kundsökningen bygger på kundregistret. Fakturanummer och OCR används endast för att hitta vilken registrerad kund fakturan tillhör.</p></div></div>${receivableSearchBar()}<div id="receivable-overview-region">${customerOverview()}</div><div id="receivable-metrics-region">${metrics()}</div><section class="panel"><div class="toolbar"><span class="hint">Högerklicka på en faktura för kommentarer, betalningspåminnelse eller eventuell återbetalning.</span>${columnPicker()}</div><div id="receivable-table-region">${table()}</div></section></main></section></div><div id="portal-overlays"></div>`;
  renderOverlays();
  const requestedInvoiceId=new URLSearchParams(location.search).get('invoice');
  if(requestedInvoiceId){
    const invoice=invoiceById(requestedInvoiceId);
    if(invoice){
      selectedReceivableCustomerId=String(invoice.customerId||'');
      selectedReceivableInvoiceId=String(invoice.id);
      receivableSearch=String(invoice.invoiceNumber||'');
      receivableSuggestionsOpen=false;
      applyReceivableFilterDom();
      requestAnimationFrame(()=>document.querySelector('.invoice-row[data-invoice-id="'+CSS.escape(String(invoice.id))+'"]')?.scrollIntoView?.({block:'center'}));
    }
  }
}
async function loadReceivables(){
  if(mode!=='supabase'){const data=await api('/receivables');invoices=data.invoices||[];receivableCustomers=data.customers||[];portalView();return}
  const ctx=await supabaseContext();
  if(!ctx.authenticated||!ctx.company){loginView();return}
  session={user:ctx.user,company:ctx.company};
  const companyFilter='company_id=eq.'+encodeURIComponent(ctx.company.id);
  const [customersData,invoicesData,transactionsData,creditAdjustmentsData,creditRefundsData,commentRows,reminderRows]=await Promise.all([
    supabaseRows('customers',ctx.accessToken,companyFilter+'&archived_at=is.null'),
    supabaseRows('invoices',ctx.accessToken,companyFilter),
    supabaseRows('invoice_transactions',ctx.accessToken,companyFilter),
    supabaseRows('customer_invoice_credit_adjustments',ctx.accessToken,companyFilter),
    supabaseRows('customer_credit_refunds',ctx.accessToken,companyFilter),
    supabaseRows('invoice_comments',ctx.accessToken,companyFilter+'&order=created_at.asc'),
    supabaseRows('invoice_reminders',ctx.accessToken,companyFilter+'&order=reminder_date.asc')
  ]);
  const customersById=new Map((customersData||[]).map(row=>[String(row.id),row]));
  const txByInvoice=new Map();
  for(const tx of transactionsData||[]){const key=String(tx.invoice_id);if(!txByInvoice.has(key))txByInvoice.set(key,[]);txByInvoice.get(key).push({
    id:tx.id,transactionType:tx.transaction_type,paymentMethod:tx.payment_method,paymentDate:tx.payment_date,postingDate:tx.posting_date,batchNumber:tx.batch_number,journalNumber:tx.journal_number,amountOre:Number(tx.amount_ore||0),approved:tx.approved,account:tx.account,bankReference:tx.bank_reference
  })}
  const commentsByInvoice=new Map();for(const row of commentRows||[]){const key=String(row.invoice_id);if(!commentsByInvoice.has(key))commentsByInvoice.set(key,[]);commentsByInvoice.get(key).push({id:row.id,companyId:row.company_id,invoiceId:row.invoice_id,text:row.comment_text,authorId:row.author_user_id,authorName:row.author_name,createdAt:row.created_at})}
  const remindersByInvoice=new Map();for(const row of reminderRows||[]){const key=String(row.invoice_id);if(!remindersByInvoice.has(key))remindersByInvoice.set(key,[]);remindersByInvoice.get(key).push(row.record_json||{id:row.id,reminderNumber:row.reminder_number,reminderDate:row.reminder_date,kind:row.kind,createdAt:row.created_at})}
  const adjustmentByCredit=new Map((creditAdjustmentsData||[]).map(row=>[String(row.credit_invoice_id),row]));
  const refundByCredit=new Map((creditRefundsData||[]).map(row=>[String(row.credit_invoice_id),row]));
  invoices=(invoicesData||[]).filter(row=>row.status!=='Väntar på bunt').map(row=>{const customer=customersById.get(String(row.customer_id))||{},adjustment=adjustmentByCredit.get(String(row.id))||null,refund=refundByCredit.get(String(row.id))||null,refundDueOre=Number(adjustment?.refund_due_ore||0),refundPaidOre=Number(refund?.amount_ore||0),refundOutstandingOre=Math.max(0,refundDueOre-refundPaidOre),credit=adjustment?{originalInvoiceId:adjustment.original_invoice_id,creditInvoiceId:adjustment.credit_invoice_id,reason:adjustment.reason||'',creditAmountOre:Number(adjustment.credit_amount_ore||0),offsetAmountOre:Number(adjustment.offset_amount_ore||0),refundDueOre,refund:refund?{amountOre:refundPaidOre,refundDate:refund.refund_date,refundAccount:refund.refund_account,bankReference:refund.bank_reference}:null,refundPaidOre,refundOutstandingOre,refundStatus:refundDueOre===0?'not-required':refundOutstandingOre===0?'refunded':'pending'}:null;return{
    id:row.id,kind:'customer',customerId:row.customer_id,customerNumber:customer.customer_number||'',customerName:customer.name||'',customerOrgNumber:customer.org_number||'',invoiceNumber:row.invoice_number,ocr:row.ocr||'',invoiceDate:row.invoice_date,postingDate:row.posting_date,dueDate:row.due_date,totalOre:Number(row.total_ore||0),remainingOre:Number(row.remaining_ore||0),vatOre:Number(row.vat_ore||0),status:row.status,paymentMethod:row.payment_method,paymentAccount:row.payment_account,invoiceAccount:row.invoice_account,batchNumber:row.batch_number,journalNumber:row.journal_number,customerType:customer.customer_type||'business',reminderFeeAgreed:Boolean(customer.reminder_fee_agreed),commentCount:(commentsByInvoice.get(String(row.id))||[]).length,transactions:txByInvoice.get(String(row.id))||[],reminders:remindersByInvoice.get(String(row.id))||[],credit
  }});
  receivableCustomers=(customersData||[]).map(customer=>{const list=invoices.filter(i=>String(i.customerId)===String(customer.id));return{
    customerId:customer.id,customerNumber:customer.customer_number,customerName:customer.name,orgNumber:customer.org_number||'',invoiceCount:list.length,openInvoiceCount:list.filter(i=>Number(i.remainingOre)!==0).length,remainingOre:list.reduce((sum,i)=>sum+Number(i.remainingOre||0),0)
  }});
  portalView();
}
async function openComments(invoiceId,{compose=false}={}){
  contextMenu=null;
  let comments;
  if(mode==='demo')comments=demoComments(invoiceId);
  else if(mode==='supabase'){
    const ctx=await supabaseContext();
    const rows=await window.LTSupabase.from('invoice_comments',ctx.accessToken).select('*','company_id=eq.'+encodeURIComponent(ctx.company.id)+'&invoice_id=eq.'+encodeURIComponent(invoiceId)+'&order=created_at.asc');
    comments=(rows||[]).map(row=>({id:row.id,companyId:row.company_id,invoiceId:row.invoice_id,text:row.comment_text,authorId:row.author_user_id,authorName:row.author_name,createdAt:row.created_at}));
  }else comments=(await api('/invoices/'+encodeURIComponent(invoiceId)+'/comments')).comments;
  modal={type:'comments',invoiceId,comments,draftText:'',compose};
  renderOverlays();
  if(compose)requestAnimationFrame(()=>document.getElementById('invoice-comment-draft')?.focus());
}
async function previewReminder(form){
  const invoice=invoiceById(modal.invoiceId);
  const raw=Object.fromEntries(new FormData(form));
  const formValues={sentDate:raw.sentDate,includeInterest:raw.includeInterest==='on',includeReminderFee:raw.includeReminderFee==='on',includeBusinessLatePaymentCompensation:raw.includeBusinessLatePaymentCompensation==='on',note:raw.note||''};
  const requestOptions={sentDate:formValues.sentDate,includeInterest:formValues.includeInterest,includeReminderFee:formValues.includeReminderFee,includeBusinessLatePaymentCompensation:formValues.includeBusinessLatePaymentCompensation};
  const demoOptions={...requestOptions,note:formValues.note,customerType:invoice.customerType,reminderFeeAgreed:Boolean(invoice.reminderFeeAgreed)};
  try{
    const preview=mode==='demo'
      ?R.reminderPreview({...invoice,reminders:[...(invoice.reminders||[]),...demoReminders(invoice.id)]},demoOptions,legalRates)
      :mode==='supabase'
        ?R.reminderPreview(invoice,demoOptions,legalRates)
        :(await api('/invoices/'+encodeURIComponent(invoice.id)+'/reminders/preview',{method:'POST',body:requestOptions})).preview;
    modal={...modal,preview,error:'',sentDate:formValues.sentDate,formValues};
  }catch(error){
    modal={...modal,preview:null,error:error.message,sentDate:formValues.sentDate,formValues};
  }
  renderOverlays();
}

function accessRecoveryView(message='Du saknar behörighet för den här arbetsytan.'){
  app.innerHTML=`<main class="access-recovery"><section class="access-recovery-card"><span class="eyebrow">Behörighet</span><h1>Den här arbetsytan är inte tillgänglig</h1><p>${escapeHtml(message)}</p><p>Du är fortfarande säkert inloggad. Logga ut och byt konto, eller gå till företagets översikt.</p><div class="access-recovery-actions"><button class="button" data-action="logout" type="button">Logga ut och byt konto</button><a class="button ghost" href="./dashboard.html">Gå till översikten</a></div></section></main>`;
}
async function boot(){
  try{legalRates=await fetch('../config/legal-rates.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Räntekonfigurationen kunde inte laddas.');return r.json()});if(!R)throw new Error('Reskontramodulen kunde inte laddas.');if(mode==='demo'){const demoState=Demo?.state?.()||null,demoCustomers=demoState?.customers||[],customersByNumber=new Map(demoCustomers.map(customer=>[String(customer.customerNumber),customer])),source=demoState?.customerInvoices||demoInvoices;invoices=structuredClone(source).map(invoice=>{const customer=customersByNumber.get(String(invoice.customerNumber))||{};return{...invoice,customerId:invoice.customerNumber,customerOrgNumber:invoice.customerOrgNumber||customer.orgNumber||'',interestStartBasis:invoice.interestStartBasis||'predetermined-due-date',interestStartEvidenceSource:invoice.interestStartEvidenceSource||'issued-invoice-document',interestStartVerifiedAt:invoice.interestStartVerifiedAt||String(invoice.invoiceDate||today())+'T09:00:00.000Z'}});receivableCustomers=[...new Map(invoices.map(invoice=>[invoice.customerNumber,invoice])).values()].map(invoice=>({customerId:invoice.customerNumber,customerNumber:invoice.customerNumber,customerName:invoice.customerName,orgNumber:invoice.customerOrgNumber||'',invoiceCount:invoices.filter(row=>row.customerNumber===invoice.customerNumber).length,openInvoiceCount:invoices.filter(row=>row.customerNumber===invoice.customerNumber&&Number(row.remainingOre)!==0).length,remainingOre:invoices.filter(row=>row.customerNumber===invoice.customerNumber).reduce((sum,row)=>sum+Number(row.remainingOre||0),0)}));session={user:{displayName:'Demoanvändare'},company:{name:'Rollands Frukt o Grönt AB'}};portalView();return}if(mode==='supabase'){const state=await supabaseContext();if(!state.authenticated){loginView();return}session={user:state.user,company:state.company};await loadReceivables();return}const state=await api('/session');if(!state.authenticated){loginView();return}session={user:state.user,company:state.company||{id:state.companyId,name:'Företaget'}};await loadReceivables()}catch(error){if(error.code==='ACCESS_DENIED'){accessRecoveryView(error.message);return}app.innerHTML=`<main class="boot"><strong>Kunde inte starta portalen</strong><span>${escapeHtml(error.message)}</span></main>`}}

document.addEventListener('submit',async event=>{
  const form=event.target;
  if(form.id==='login-form'){event.preventDefault();const values=Object.fromEntries(new FormData(form));try{if(mode==='supabase'){const ctx=await window.LTSupabaseUat.signIn(String(values.username||'').trim(),String(values.password||''),String(values.totp||'').trim());if(!ctx.company)throw new Error('Kontot saknar företagsbehörighet i Supabase.');session={user:ctx.user,company:ctx.company};await loadReceivables();return}const data=await api('/auth/login',{method:'POST',body:values});csrfToken=data.csrfToken;sessionStorage.setItem('rollands-csrf',csrfToken);session={user:data.user,company:data.company};loginCompanies=[];await loadReceivables()}catch(error){if(error.code==='COMPANY_REQUIRED'){loginCompanies=error.data.companies||[];loginView('Välj vilket företag du vill öppna.')}else loginView(error.message)}return}
  if(form.dataset.form==='refund'){
    event.preventDefault();
    const invoice=invoiceById(modal.invoiceId),values=Object.fromEntries(new FormData(form));
    try{
      if(!invoice?.credit||invoice.credit.refundStatus!=='pending')throw new Error('Det finns ingen väntande återbetalning för kreditfakturan.');
      const refundAccount=String(values.refundAccount||'').trim(),refundDate=String(values.refundDate||'').trim(),bankReference=String(values.bankReference||'').trim();
      if(!['1920','1930','1940'].includes(refundAccount))throw new Error('Välj konto 1920, 1930 eller 1940.');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(refundDate))throw new Error('Ange ett giltigt återbetalningsdatum.');
      if(bankReference.length<4||bankReference.length>120)throw new Error('Bankreferensen måste vara 4–120 tecken.');
      if(mode==='demo')throw new Error('Återbetalningar bokförs endast i den skyddade företagsportalen.');
      if(mode==='supabase'){
        const ctx=await supabaseContext();
        await window.LTSupabase.rpc('register_customer_credit_refund',{p_company_id:ctx.company.id,p_request_id:crypto.randomUUID(),p_credit_invoice_id:invoice.id,p_refund_date:refundDate,p_refund_account:refundAccount,p_bank_reference:bankReference},ctx.accessToken);
      }else{
        await api('/customer-invoices/'+encodeURIComponent(invoice.id)+'/refund',{method:'POST',body:{requestId:crypto.randomUUID(),refundDate,refundAccount,bankReference}});
      }
      modal=null;feedback='Återbetalningen är registrerad, bokförd och avprickad i Kundreskontra.';await loadReceivables();
    }catch(error){modal={...modal,error:error.message};renderOverlays()}
    return;
  }
  if(form.dataset.form==='comment'){
    event.preventDefault();
    const text=String(new FormData(form).get('text')||'');
    try{
      let comment;
      if(mode==='demo'){
        const actor={id:'demo-user',name:'Demoanvändare'};
        comment=R.createInvoiceComment({invoiceId:modal.invoiceId,companyId:'demo-company',actor,text});
        const list=[...demoComments(modal.invoiceId),comment];setDemoComments(modal.invoiceId,list);
      }else if(mode==='supabase'){
        const ctx=await supabaseContext();
        const saved=(await window.LTSupabase.rpc('create_invoice_comment',{p_company_id:ctx.company.id,p_invoice_id:modal.invoiceId,p_text:text},ctx.accessToken))?.[0];
        if(!saved)throw new Error('Kommentaren kunde inte sparas i Supabase.');
        comment={id:saved.id,companyId:ctx.company.id,invoiceId:saved.invoice_id,text:saved.comment_text,authorId:saved.author_user_id,authorName:saved.author_name,createdAt:saved.created_at};
      }else comment=(await api('/invoices/'+encodeURIComponent(modal.invoiceId)+'/comments',{method:'POST',body:{text}})).comment;
      const invoice=invoiceById(modal.invoiceId);
      const list=[...(modal.comments||[]),comment];
      if(invoice)invoice.commentCount=list.length;
      modal={...modal,comments:list,draftText:'',compose:false,error:''};
      renderReceivableResults();renderOverlays();
    }catch(error){const el=form.querySelector('.form-error');if(el)el.textContent=error.message}
    return;
  }
  if(form.dataset.form==='reminder'){
    event.preventDefault();if(!modal.preview)return;
    const invoice=invoiceById(modal.invoiceId),raw=Object.fromEntries(new FormData(form));
    const body={sentDate:raw.sentDate,includeInterest:raw.includeInterest==='on',includeReminderFee:raw.includeReminderFee==='on',includeBusinessLatePaymentCompensation:raw.includeBusinessLatePaymentCompensation==='on',kind:raw.includeBusinessLatePaymentCompensation==='on'?'escalation':'payment-reminder',note:raw.note||''};
    try{
      if(mode==='demo'){
        const record={...R.createReminderRecord({invoice:{...invoice,reminders:[...(invoice.reminders||[]),...demoReminders(invoice.id)]},companyId:'demo-company',actor:{id:'demo-user',name:'Demoanvändare'},options:{...body,reminderFeeAgreed:Boolean(invoice.reminderFeeAgreed),customerType:invoice.customerType},config:legalRates}),reminderNumber:'P-'+invoice.invoiceNumber+'-DEMO01',pdfSha256:''};
        setDemoReminders(invoice.id,[...demoReminders(invoice.id),record]);modal=null;renderReceivableResults();renderOverlays();
      }else if(mode==='supabase'){
        const ctx=await supabaseContext();
        const record=R.createReminderRecord({invoice,companyId:ctx.company.id,actor:{id:ctx.authUser.id,name:ctx.user.displayName},options:{...body,reminderFeeAgreed:Boolean(invoice.reminderFeeAgreed),customerType:invoice.customerType},config:legalRates});
        const saved=(await window.LTSupabase.rpc('create_invoice_reminder',{p_company_id:ctx.company.id,p_invoice_id:invoice.id,p_record:record},ctx.accessToken))?.[0];
        if(!saved)throw new Error('Påminnelsen kunde inte sparas i Supabase.');
        modal=null;await loadReceivables();
      }else{await api('/invoices/'+encodeURIComponent(invoice.id)+'/reminders',{method:'POST',body});modal=null;await loadReceivables()}
    }catch(error){modal={...modal,error:error.message};renderOverlays()}
    return;
  }
});

document.addEventListener('input',event=>{
  if(event.target.id==='receivable-search-input'){
    receivableSearch=event.target.value;
    selectedReceivableCustomerId='';
    selectedReceivableInvoiceId='';
    receivableSuggestionsOpen=Boolean(normalizeSearch(receivableSearch));
    receivableSuggestionIndex=-1;
    applyReceivableFilterDom();
    renderReceivableSearchSuggestions();
    return;
  }
  if(event.target.id==='invoice-comment-draft'&&modal?.type==='comments'){
    modal.draftText=event.target.value;return;
  }
});
document.addEventListener('change',event=>{const id=event.target.dataset.column;if(!id)return;if(event.target.checked)visibleColumns.add(id);else visibleColumns.delete(id);saveJson(COLUMN_KEY,[...visibleColumns]);renderReceivableResults()});
document.addEventListener('contextmenu',event=>{const row=event.target.closest('[data-invoice-id]');if(!row)return;event.preventDefault();contextMenu={invoiceId:row.dataset.invoiceId,x:Math.min(event.clientX,innerWidth-270),y:Math.min(event.clientY,innerHeight-190)};renderOverlays()});
document.addEventListener('focusin',event=>{
  if(event.target.id!=='receivable-search-input'||selectedReceivableCustomerId)return;
  if(normalizeSearch(receivableSearch)){receivableSuggestionsOpen=true;renderReceivableSearchSuggestions()}
});
document.addEventListener('keydown',event=>{
  if(event.target.id!=='receivable-search-input')return;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();
    if(!normalizeSearch(receivableSearch))return;
    if(!receivableSuggestionsOpen){receivableSuggestionsOpen=true;receivableSuggestionIndex=-1;renderReceivableSearchSuggestions()}
    moveReceivableSuggestion(event.key==='ArrowDown'?1:-1);
    return;
  }
  if(event.key==='Enter'&&receivableSuggestionsOpen&&receivableSuggestionIndex>=0){
    event.preventDefault();
    searchSuggestionButtons()[receivableSuggestionIndex]?.click();
    return;
  }
  if(event.key==='Escape'&&receivableSuggestionsOpen){
    event.preventDefault();receivableSuggestionsOpen=false;receivableSuggestionIndex=-1;renderReceivableSearchSuggestions();return;
  }
  if(event.key==='Tab'&&receivableSuggestionsOpen){receivableSuggestionsOpen=false;receivableSuggestionIndex=-1;renderReceivableSearchSuggestions()}
});
document.addEventListener('pointerdown',event=>{
  if(!receivableSuggestionsOpen||event.target.closest('.receivable-search-field'))return;
  receivableSuggestionsOpen=false;receivableSuggestionIndex=-1;renderReceivableSearchSuggestions();
});
document.addEventListener('click',async event=>{
  const stopRoot=event.target.closest('[data-stop]');
  if(stopRoot)event.stopPropagation();
  const button=event.target.closest('[data-action]');
  if(stopRoot&&button&&!stopRoot.contains(button))return;
  if(!button){if(contextMenu){contextMenu=null;renderOverlays()}return}
  const action=button.dataset.action;
  try{
    if(action==='select-receivable-search'){
      selectedReceivableCustomerId=button.dataset.customerId||'';
      selectedReceivableInvoiceId=button.dataset.kind==='invoice'?(button.dataset.invoiceId||''):'';
      receivableSearch=button.dataset.searchValue||'';
      receivableSuggestionsOpen=false;
      receivableSuggestionIndex=-1;
      applyReceivableFilterDom();
      renderReceivableSearchSuggestions();
      requestAnimationFrame(()=>{
        const input=document.getElementById('receivable-search-input');
        input?.focus?.({preventScroll:true});
        if(selectedReceivableInvoiceId){
          const row=document.querySelector('.invoice-row[data-invoice-id="'+CSS.escape(selectedReceivableInvoiceId)+'"]');
          row?.scrollIntoView?.({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
        }
      });
      return;
    }
    if(action==='filter-customer'){selectedReceivableCustomerId=button.dataset.customerId||'';selectedReceivableInvoiceId='';receivableSearch='';receivableSuggestionsOpen=false;receivableSuggestionIndex=-1;applyReceivableFilterDom();renderReceivableSearchSuggestions();return}
    if(action==='clear-receivable-filter'){selectedReceivableCustomerId='';selectedReceivableInvoiceId='';receivableSearch='';receivableSuggestionsOpen=false;receivableSuggestionIndex=-1;applyReceivableFilterDom();renderReceivableSearchSuggestions();return}
    if(action==='close-context'){contextMenu=null;renderOverlays();return}
    if(action==='comment'){await openComments(button.dataset.id,{compose:true});return}
    if(action==='show-comments'){await openComments(button.dataset.id,{compose:false});return}
    if(action==='new-comment'){modal={...modal,compose:true,draftText:''};renderOverlays();requestAnimationFrame(()=>document.getElementById('invoice-comment-draft')?.focus());return}
    if(action==='reminder'){contextMenu=null;modal={type:'reminder',invoiceId:button.dataset.id,preview:null,error:'',sentDate:today(),formValues:{sentDate:today(),includeInterest:true,includeReminderFee:false,includeBusinessLatePaymentCompensation:false,note:''}};renderOverlays();return}
    if(action==='refund'){const invoice=invoiceById(button.dataset.id);contextMenu=null;if(!invoice?.credit||invoice.credit.refundStatus!=='pending')throw new Error('Det finns ingen väntande återbetalning för kreditfakturan.');modal={type:'refund',invoiceId:invoice.id,error:''};renderOverlays();return}
    if(action==='close-modal'){modal=null;renderOverlays();return}
    if(action==='reset-columns'){visibleColumns=new Set(R.RECEIVABLE_COLUMNS.map(c=>c.id));saveJson(COLUMN_KEY,[...visibleColumns]);renderReceivableResults();return}
    if(action==='preview-reminder'){await previewReminder(button.closest('form'));return}
    if(action==='logout'&&mode==='api'){if(csrfToken)await api('/auth/logout',{method:'POST',body:{}}).catch(()=>{});sessionStorage.removeItem('rollands-csrf');csrfToken='';session=null;loginView()}if(action==='logout'&&mode==='supabase'){await window.LTSupabaseUat.signOut();session=null;loginView()}
  }catch(error){if(modal){modal={...modal,error:error.message};renderOverlays()}}
});

boot();
