(function(){
  function connect(){
    const header=document.querySelector('.site-header'),footer=document.querySelector('.site-footer .footer-links');
    if(!header)return false;
    if(!header.querySelector('[data-portal-entry]')){const a=document.createElement('a');a.className='header-action';a.dataset.portalEntry='1';a.href='./portal/dashboard.html?demo=1';a.textContent='Demoportal';a.title='Öppna den fiktiva företagsportalen';header.append(a)}
    const admin=footer?.querySelector('a[href*="admin"]');if(admin){admin.href='./portal/dashboard.html?demo=1';admin.textContent='Öppna demoportal'}
    return true;
  }
  if(!connect()){const observer=new MutationObserver(()=>{if(connect())observer.disconnect()});observer.observe(document.documentElement,{childList:true,subtree:true})}
})();
