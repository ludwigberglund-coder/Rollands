(function(){
  'use strict';
  const cfg=window.LT_SUPABASE;
  const CLOCK_SKEW_RETRY_DELAYS=[700,1400,2800];
  let lastMutationAt=0;
  function headers(token,extra){return Object.assign({'apikey':cfg.publishableKey,'Content-Type':'application/json'},token?{'Authorization':'Bearer '+token}:{},extra||{});}
  function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  function errorMessage(data,status){
    if(data&&typeof data==='object')return data.message||data.error_description||data.error||('Supabase request failed: '+status);
    if(typeof data==='string'&&data.trim())return data.trim();
    return 'Supabase request failed: '+status;
  }
  function isJwtFutureError(message){return /jwt.*issued.*future|issued\s+at\s+future/i.test(String(message||''));}
  function isSafeToRetry(options){const method=String(options?.method||'GET').toUpperCase();return method==='GET'||method==='HEAD';}
  async function request(path,options={}){
    const requestOptions=Object.assign({},options,{headers:headers(options.token,options.headers)});
    for(let attempt=0;;attempt+=1){
      const response=await fetch(cfg.url+path,requestOptions);
      const text=await response.text(); let data=null;
      if(text){try{data=JSON.parse(text);}catch{data=text;}}
      if(response.ok){const method=String(options?.method||'GET').toUpperCase();if(!['GET','HEAD'].includes(method))lastMutationAt=Date.now();return data;}
      const message=errorMessage(data,response.status);
      const canRetry=isSafeToRetry(options)&&(response.status===401||response.status===403)&&isJwtFutureError(message)&&attempt<CLOCK_SKEW_RETRY_DELAYS.length;
      if(canRetry){await sleep(CLOCK_SKEW_RETRY_DELAYS[attempt]);continue;}
      if(isJwtFutureError(message)){
        const error=new Error('Den säkra sessionen håller fortfarande på att synkroniseras. Vänta några sekunder och försök logga in igen.');
        error.status=response.status;
        error.data=data;
        throw error;
      }
      const error=new Error(message);
      error.status=response.status;
      error.data=data;
      error.code=(data&&typeof data==='object'&&(data.code||data.error_code))||'';
      throw error;
    }
  }
  async function storageRequest(path,token,options={}){
    const headers=Object.assign({'apikey':cfg.publishableKey,'Authorization':'Bearer '+token},options.headers||{});
    const response=await fetch(cfg.url+'/storage/v1'+path,Object.assign({},options,{headers}));
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.message||data.error||('Storage request failed: '+response.status));}
    return response;
  }
  window.LTSupabase={
    config:cfg,
    signIn:({email,password})=>request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})}),
    refreshSession:(refreshToken)=>request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:String(refreshToken||'')})}),
    signOut:(token,scope='global')=>request('/auth/v1/logout'+(scope==='global'?'':'?scope='+encodeURIComponent(scope)),{method:'POST',token}),
    getUser:(token)=>request('/auth/v1/user',{token}),
    mfaEnroll:(token,friendlyName)=>request('/auth/v1/factors',{method:'POST',token,body:JSON.stringify({factor_type:'totp',friendly_name:String(friendlyName||'LT Studio')})}),
    mfaChallenge:(token,factorId)=>request('/auth/v1/factors/'+encodeURIComponent(factorId)+'/challenge',{method:'POST',token,body:JSON.stringify({})}),
    mfaVerify:(token,factorId,challengeId,code)=>request('/auth/v1/factors/'+encodeURIComponent(factorId)+'/verify',{method:'POST',token,body:JSON.stringify({challenge_id:challengeId,code:String(code||'')})}),
    rpc:(name,args,token)=>request('/rest/v1/rpc/'+encodeURIComponent(name),{method:'POST',token,headers:{Prefer:'return=representation'},body:JSON.stringify(args||{})}),
    functions:{invoke:(name,body,token)=>request('/functions/v1/'+encodeURIComponent(name),{method:'POST',token,body:JSON.stringify(body||{})})},
    from:(table,token)=>({
      select:(query='*',filters='')=>request('/rest/v1/'+encodeURIComponent(table)+'?select='+encodeURIComponent(query)+(filters?'&'+filters:''),{token}),
      insert:(rows)=>request('/rest/v1/'+encodeURIComponent(table),{method:'POST',token,headers:{Prefer:'return=representation'},body:JSON.stringify(rows)}),
      upsert:(rows)=>request('/rest/v1/'+encodeURIComponent(table),{method:'POST',token,headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(rows)}),
      update:(values,filters)=>request('/rest/v1/'+encodeURIComponent(table)+'?'+filters,{method:'PATCH',token,headers:{Prefer:'return=representation'},body:JSON.stringify(values)}),
      delete:(filters)=>request('/rest/v1/'+encodeURIComponent(table)+'?'+filters,{method:'DELETE',token,headers:{Prefer:'return=representation'}})
    }),
    storage:{
      upload:async(bucket,path,file,token)=>{
        const response=await storageRequest('/object/'+encodeURIComponent(bucket)+'/'+path.split('/').map(encodeURIComponent).join('/'),token,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','x-upsert':'false'},body:file});
        return response.json().catch(()=>({}));
      },
      download:async(bucket,path,token)=>{
        const response=await storageRequest('/object/authenticated/'+encodeURIComponent(bucket)+'/'+path.split('/').map(encodeURIComponent).join('/'),token,{method:'GET'});
        return response.blob();
      },
      remove:async(bucket,paths,token)=>{
        const response=await storageRequest('/object/'+encodeURIComponent(bucket),token,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:paths})});
        return response.json().catch(()=>({}));
      }
    }
  };

  const PAGE_REALTIME_TABLES=Object.freeze({
    'dashboard.html':['customers','invoices','supplier_invoices','supplier_payments','bank_payments','automation_proposals','financial_batches','payroll_runs'],
    'index.html':['customers','invoices','invoice_transactions','invoice_comments','invoice_reminders','customer_invoice_credit_adjustments','customer_credit_refunds'],
    'receivables.html':['customers','invoices','invoice_transactions','invoice_comments','invoice_reminders','customer_invoice_credit_adjustments','customer_credit_refunds'],
    'customers.html':['customers','invoices'],
    'invoices.html':['customers','invoices','customer_invoice_drafts','customer_invoice_documents','customer_invoice_number_reservations','customer_invoice_credit_adjustments','customer_credit_refunds','company_invoice_settings','company_revenue_accounts','financial_batches'],
    'suppliers.html':['suppliers','supplier_change_events'],
    'supplier-invoices.html':['suppliers','supplier_invoices','supplier_payments','supplier_invoice_date_corrections','documents','financial_batches'],
    'supplier-ledger.html':['suppliers','supplier_invoices','supplier_payments','supplier_invoice_date_corrections','documents','financial_batches'],
    'payables-intake.html':['suppliers','supplier_invoices','documents'],
    'batches.html':['financial_batches','financial_batch_transactions','financial_batch_lines','financial_batch_events'],
    'accounting.html':['journal_entries','journal_lines','accounting_periods','period_unlock_requests','financial_batches','financial_batch_transactions'],
    'accounts.html':['company_revenue_accounts'],
    'bank.html':['bank_payments','automation_proposals','invoices','invoice_transactions'],
    'automation.html':['automation_proposals','bank_payments','invoices','invoice_transactions'],
    'inventory.html':['inventory_items','inventory_movements','inventory_adjustments','financial_batches'],
    'payments.html':['invoices','invoice_transactions','supplier_payments','financial_batches'],
    'payroll.html':['payroll_runs','financial_batches'],
    'documents.html':['documents','customer_invoice_documents','supplier_invoices'],
    'reports.html':['journal_entries','journal_lines','invoices','invoice_transactions','supplier_invoices','supplier_payments'],
    'profile.html':['app_users'],
    'company-settings.html':['companies','company_invoice_settings'],
    'website.html':['website_cms_state','website_cms_revisions']
  });
  let activeRealtime=null;
  let realtimeSessionRefresh=0;
  let realtimeReloadTimer=0;
  function realtimePageName(){const page=location.pathname.split('/').filter(Boolean).pop()||'index.html';return page.includes('.')?page:'index.html';}
  function realtimeUrl(){
    const url=new URL(cfg.url);
    const protocol=url.protocol==='https:'?'wss:':'ws:';
    return protocol+'//'+url.host+'/realtime/v1/websocket?apikey='+encodeURIComponent(cfg.publishableKey)+'&vsn=1.0.0';
  }
  function createRealtimeWatcher({token,tables,onChange,onStatus}){
    let socket=null,closed=false,heartbeat=0,reconnectTimer=0,reconnectAttempt=0,ref=0,joinRef='',accessToken=token;
    const topic='realtime:lt-studio-'+crypto.randomUUID();
    const nextRef=()=>String(++ref);
    function push(event,payload,targetTopic=topic,refValue=nextRef(),jr=joinRef||null){
      if(!socket||socket.readyState!==WebSocket.OPEN)return;
      socket.send(JSON.stringify({topic:targetTopic,event,payload,ref:refValue,join_ref:jr}));
    }
    function cleanupSocket(){
      if(heartbeat){clearInterval(heartbeat);heartbeat=0}
      if(socket){socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;try{socket.close()}catch{}socket=null}
    }
    function scheduleReconnect(){
      if(closed)return;
      const delay=Math.min(10000,800*Math.pow(1.7,reconnectAttempt++));
      clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,delay);
      onStatus?.('reconnecting');
    }
    function connect(){
      cleanupSocket();
      if(closed||!accessToken)return;
      socket=new WebSocket(realtimeUrl());
      socket.onopen=()=>{
        reconnectAttempt=0;joinRef=nextRef();
        push('phx_join',{
          config:{
            broadcast:{ack:false,self:false},
            presence:{enabled:false},
            postgres_changes:tables.map(table=>({event:'*',schema:'public',table}))
          },
          access_token:accessToken
        },topic,joinRef,joinRef);
        heartbeat=setInterval(()=>push('heartbeat',{},'phoenix',nextRef(),null),20000);
      };
      socket.onmessage=event=>{
        let message;try{message=JSON.parse(event.data)}catch{return}
        if(message.event==='phx_reply'&&message.ref===joinRef){
          const ok=message.payload?.status==='ok';onStatus?.(ok?'subscribed':'error',message.payload);if(!ok)scheduleReconnect();return;
        }
        if(message.event==='system'){onStatus?.(message.payload?.status==='ok'?'subscribed':'error',message.payload);return}
        if(message.event==='postgres_changes')onChange?.(message.payload);
        if(message.event==='phx_error'||message.event==='phx_close')scheduleReconnect();
      };
      socket.onerror=()=>onStatus?.('error');
      socket.onclose=()=>{cleanupSocket();scheduleReconnect()};
    }
    connect();
    return {
      updateToken(next){
        if(!next||next===accessToken)return;
        accessToken=next;
        push('access_token',{access_token:next},topic,nextRef(),joinRef||null);
      },
      close(){closed=true;clearTimeout(reconnectTimer);cleanupSocket();onStatus?.('closed')}
    };
  }
  function editorIsActive(){
    const el=document.activeElement;
    if(!el)return false;
    if(el.matches?.('textarea,select,[contenteditable="true"]'))return true;
    if(el.matches?.('input')&&!['search','checkbox','radio','button','submit'].includes(String(el.type||'').toLowerCase()))return true;
    return Boolean(document.querySelector('.modal-backdrop,.invoice-credit-dialog,.payment-confirm-dialog'));
  }
  function showRealtimePending(){
    let node=document.getElementById('lt-realtime-pending');
    if(node)return;
    node=document.createElement('button');node.id='lt-realtime-pending';node.type='button';node.className='button small';
    node.textContent='Ny gemensam data · uppdatera';
    Object.assign(node.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:'10000',boxShadow:'0 10px 30px rgba(0,0,0,.18)'});
    node.addEventListener('click',()=>location.reload());
    document.body.appendChild(node);
  }
  function safeRealtimeReload(){
    if(Date.now()-lastMutationAt<1800)return;
    if(editorIsActive()){showRealtimePending();return}
    clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer=setTimeout(()=>location.reload(),250);
  }
  function autoSync(ctx){
    const tables=PAGE_REALTIME_TABLES[realtimePageName()]||[];
    if(!ctx?.authenticated||!ctx?.company?.id||!ctx?.accessToken||!tables.length)return;
    const key=ctx.company.id+'|'+tables.join(',');
    if(activeRealtime?.key===key){activeRealtime.watcher.updateToken(ctx.accessToken);return}
    activeRealtime?.watcher?.close?.();
    if(realtimeSessionRefresh){clearInterval(realtimeSessionRefresh);realtimeSessionRefresh=0}
    const watcher=createRealtimeWatcher({
      token:ctx.accessToken,
      tables,
      onChange:safeRealtimeReload,
      onStatus:status=>document.documentElement.dataset.realtimeStatus=status
    });
    activeRealtime={key,watcher};
    realtimeSessionRefresh=setInterval(()=>window.LTSupabaseUat?.context?.().catch(()=>{}),4*60*1000);
  }
  function stopRealtime(){activeRealtime?.watcher?.close?.();activeRealtime=null;if(realtimeSessionRefresh){clearInterval(realtimeSessionRefresh);realtimeSessionRefresh=0}delete document.documentElement.dataset.realtimeStatus}
  window.LTSupabaseRealtime={watch:createRealtimeWatcher,autoSync,stop:stopRealtime,pageTables:()=>PAGE_REALTIME_TABLES[realtimePageName()]||[]};

})();
