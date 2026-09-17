(function(){
  const isDemo=location.hostname.endsWith('github.io')||new URLSearchParams(location.search).has('demo');
  const suffix=isDemo?'?demo=1':'';
  function link(href,label){return `<a class="side-link" href="./${href}${suffix}">${label}</a>`}
  function enhance(){
    const sidebar=document.querySelector('.sidebar');if(!sidebar)return false;
    const existing=[...sidebar.querySelectorAll('.side-group')];
    for(const group of existing){const title=group.querySelector('span')?.textContent||'';if(/Arbetsyta|Försäljning|Ekonomi|Administration|Test & granskning/i.test(title))group.remove()}
    const company=sidebar.querySelector('.company-pill');
    const workspace=document.createElement('div');workspace.className='side-group unified-overview';workspace.innerHTML=`<span>Arbetsyta</span>${link('dashboard.html','Översikt')}`;
    const sales=document.createElement('div');sales.className='side-group unified-sales';sales.innerHTML=`<span>Försäljning</span>${link('customers.html','Kunder')}${link('invoices.html','Kundfakturor')}${link('receivables.html','Kundreskontra')}`;
    const economy=document.createElement('div');economy.className='side-group unified-economy';economy.innerHTML=`<span>Ekonomi</span>${link('bank.html','Bank & avstämning')}${link('payables.html','Leverantörsfakturor')}${link('suppliers.html','Leverantörer')}${link('inventory.html','Lager')}${link('accounting.html','Bokföring')}${link('reports.html','Rapporter')}${link('payroll.html','Lön')}${link('documents.html','Dokument')}${link('automation.html','Automationskö')}`;
    const admin=document.createElement('div');admin.className='side-group unified-admin';admin.innerHTML=`<span>Administration</span>${link('website.html','Webbplats & innehåll')}`;
    const nodes=[workspace,sales,economy,admin];
    if(isDemo){const uat=document.createElement('div');uat.className='side-group unified-uat';uat.innerHTML='<span>Test & granskning</span><a class="side-link" href="./uat.html?demo=1">Testa systemet</a>';nodes.push(uat)}
    let anchor=company||sidebar.firstChild;for(const node of nodes){anchor.after(node);anchor=node}
    const current=location.pathname.split('/').pop()||'index.html';for(const a of sidebar.querySelectorAll('a.side-link')){const href=(a.getAttribute('href')||'').split('?')[0].split('/').pop();a.classList.toggle('active',href===current)}
    return true;
  }
  if(!enhance()){const observer=new MutationObserver(()=>{if(enhance())observer.disconnect()});observer.observe(document.documentElement,{childList:true,subtree:true})}
})();
