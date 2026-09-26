const app=document.getElementById('accounts-app');
const Demo=globalThis.RollandsDemoScenario,Invoice=globalThis.RollandsInvoice;
const isDemo=new URLSearchParams(location.search).get('demo')==='1';
const isSupabase=location.hostname==='ludwigberglund-coder.github.io'&&!isDemo;
let base=[],custom=[],message='',ctx=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function revenue(){return Invoice.revenueAccounts(isDemo?(Demo.state().invoiceRevenueAccounts||[]):custom);}
function render(){
  const map=new Map(base.map(r=>[r.number,r]));for(const r of revenue())map.set(r.number,{...r,group:'Intäkter',revenue:true});
  const rows=[...map.values()].sort((a,b)=>a.number.localeCompare(b.number));
  const banner=isDemo
    ?'<div class="demo-banner">Fristående demo. Ändringar delas inte med andra användare.</div>'
    :isSupabase
      ?'<div class="payments-live-banner"><span class="payments-live-dot" aria-hidden="true"></span><div><b>Supabase UAT · Realtime</b><small>Företagets egna intäktskonton delas mellan alla behöriga användare.</small></div></div>'
      :'<div class="notice">Privat serverläge.</div>';
  const canEdit=isDemo||isSupabase;
  app.innerHTML=`<div class="portal"><aside class="sidebar"></aside><section class="main"><header class="topbar"><div><h1>Kontoplan & intäktskonton</h1><p>Ekonomi / Kontoinställningar</p></div></header><main class="content invoice-workspace">${banner}<div class="invoice-toolbar"><div><h2>Välj hur intäkten bokförs</h2><p>Intäktskontot sparas på fakturan och används i dess verifikation. En ändring här skriver inte om redan bokförda fakturor.</p></div><a class="button" href="./invoices.html${isDemo?'?demo=1':''}">Öppna fakturaverktyget</a></div>${message?`<div class="invoice-alert" role="alert">${esc(message)}</div>`:''}${canEdit?`<section class="invoice-preview-card accounts-edit"><h3>Lägg till eller ändra intäktskonto</h3><form id="account-form" class="invoice-grid"><label>Kontonummer *<input name="number" inputmode="numeric" pattern="3[0-9]{3}" maxlength="4" required placeholder="Exempel: 3099"></label><label>Kontonamn *<input name="name" maxlength="120" required placeholder="Namn på er intäkt"></label><label>Momssats *<select name="vatRate" required><option value="25">25 %</option><option value="12">12 %</option><option value="6">6 %</option><option value="0">0 %</option></select></label><div class="wide"><button class="button" type="submit">Spara intäktskonto</button></div></form><p class="invoice-help">Fyra siffror i klass 3. 3740 är reserverat för öresutjämning. Momssatsen avgör när kontot kan väljas på en fakturarad.</p></section>`:''}<section class="invoice-preview-card"><h3>Konton i systemet</h3><div class="table-scroll"><table class="accounts-table"><thead><tr><th>Konto</th><th>Benämning</th><th>Moms för fakturering</th><th>Användning</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${esc(r.number)}</b></td><td>${esc(r.name)}</td><td>${r.revenue?esc((r.vatRates||[]).map(v=>v+' %').join(', ')):'–'}</td><td>${r.revenue?'Valbart intäktskonto':esc(r.group||'Ekonomi')}</td></tr>`).join('')}</tbody></table></div></section></main></section></div>`;
  globalThis.RollandsNavigation?.mount?.();
}
async function loadSupabaseAccounts(){
  ctx=await window.LTSupabaseUat.context();
  if(!ctx.authenticated||!ctx.company){location.href='./index.html';return false}
  const rows=await window.LTSupabase.from('company_revenue_accounts',ctx.accessToken).select('*','company_id=eq.'+encodeURIComponent(ctx.company.id)+'&order=account_number.asc');
  custom=(rows||[]).map(row=>({number:row.account_number,name:row.account_name,vatRates:(row.vat_rates||[]).map(Number)}));
  return true;
}
document.addEventListener('submit',async event=>{
  if(event.target.id!=='account-form'||(!isDemo&&!isSupabase))return;
  event.preventDefault();
  try{
    const fd=new FormData(event.target),row={number:String(fd.get('number')).trim(),name:String(fd.get('name')).trim(),vatRates:[Number(fd.get('vatRate'))]};
    Invoice.revenueAccounts([row]);
    if(revenue().some(a=>a.number===row.number)&&!confirm('Kontot finns redan. Ändra namn och momskoppling för framtida fakturor?'))return;
    if(isDemo){
      Demo.patch(state=>{state.invoiceRevenueAccounts=[...(state.invoiceRevenueAccounts||[]).filter(a=>a.number!==row.number),row];});
      message=`${row.number} ${row.name} är sparat i demot.`;
    }else{
      if(!ctx)await loadSupabaseAccounts();
      const saved=(await window.LTSupabase.rpc('save_company_revenue_account',{p_company_id:ctx.company.id,p_account_number:row.number,p_account_name:row.name,p_vat_rate:row.vatRates[0]},ctx.accessToken))?.[0];
      if(!saved)throw new Error('Intäktskontot kunde inte sparas i Supabase.');
      await loadSupabaseAccounts();
      message=`${row.number} ${row.name} är sparat gemensamt i Supabase och kan användas på båda datorerna.`;
    }
    render();
  }catch(error){message=error.message;render();}
});
async function boot(){
  const r=await fetch('../config/accounting-accounts.json');if(!r.ok)throw new Error('Kontoplanen kunde inte hämtas.');
  base=(await r.json()).accounts||[];
  if(isSupabase)await loadSupabaseAccounts();
  render();
}
boot().catch(error=>{message=error.message;render();});