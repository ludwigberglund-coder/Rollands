(function(){
  'use strict';
  const KEY='lt-studio-supabase-uat-session-v1';
  const COMPANY_KEY='lt-studio-supabase-uat-company-v1';
  const REFRESH_EARLY_MS=5*60*1000;
  const api=()=>window.LTSupabase;
  function parse(value){try{return JSON.parse(value||'null')}catch{return null}}
  function read(){
    return parse(sessionStorage.getItem(KEY))||parse(localStorage.getItem(KEY));
  }
  function storageMode(){
    return sessionStorage.getItem(KEY)?'session':'local';
  }
  function write(value,mode='local'){
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
    if(value)(mode==='session'?sessionStorage:localStorage).setItem(KEY,JSON.stringify(value));
  }
  function token(){return read()?.access_token||''}
  function storeSession(value){write(value||null,'session');return value||null}
  function jwtClaims(value){
    try{
      const part=String(value||'').split('.')[1]||'';
      const normalized=part.replace(/-/g,'+').replace(/_/g,'/');
      return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'=')));
    }catch{return{}}
  }
  function requiresAal2(){return window.LT_SUPABASE?.environment==='uat'}
  function normalizedLoginError(error){
    const message=String(error?.message||'');
    if(Number(error?.status)===400||/invalid login credentials|email not confirmed|invalid email or password/i.test(message)){
      const friendly=new Error('E-post eller lösenord stämmer inte, eller UAT-kontot är inte aktiverat ännu. Om det är första gången: välj “Aktivera UAT-konto / slutför MFA” nedan.');
      friendly.code='UAT_LOGIN_NOT_READY';
      friendly.status=400;
      return friendly;
    }
    return error;
  }
  async function refreshIfNeeded(current){
    const claims=jwtClaims(current?.access_token);
    const expiresAt=Number(claims.exp||0)*1000;
    if(!current?.refresh_token||!expiresAt||expiresAt-Date.now()>REFRESH_EARLY_MS)return current;
    const mode=storageMode();
    try{
      const refreshed=await api().refreshSession(current.refresh_token);
      if(!refreshed?.access_token||!refreshed?.refresh_token)throw new Error('Supabase-sessionen kunde inte förnyas.');
      write(refreshed,mode);
      return refreshed;
    }catch{
      write(null);
      return null;
    }
  }
  async function signIn(email,password,totp=''){
    let initial;
    try{initial=await api().signIn({email,password});}
    catch(error){throw normalizedLoginError(error)}
    const initialToken=initial?.access_token;
    if(!initialToken)throw new Error('Inloggningen gav ingen giltig Supabase-session.');
    if(requiresAal2()){
      const user=await api().getUser(initialToken);
      const factor=(user?.factors||[]).find(item=>item.factor_type==='totp'&&item.status==='verified');
      if(!factor){
        await api().signOut(initialToken,'global').catch(()=>{});
        throw new Error('Kontot saknar verifierad MFA. Öppna UAT-aktiveringen och slutför TOTP-registreringen.');
      }
      if(!/^[0-9]{6}$/.test(String(totp||''))){
        await api().signOut(initialToken,'global').catch(()=>{});
        throw new Error('Ange den sexsiffriga MFA-koden från din authenticator-app.');
      }
      const challenge=await api().mfaChallenge(initialToken,factor.id);
      const verified=await api().mfaVerify(initialToken,factor.id,challenge.id,String(totp));
      if(!verified?.access_token||jwtClaims(verified.access_token).aal!=='aal2'){
        await api().signOut(initialToken,'global').catch(()=>{});
        throw new Error('MFA-verifieringen misslyckades.');
      }
      write(verified,'session');
    }else write(initial,'session');
    return context();
  }
  async function signOut(scope='global'){
    const t=token();
    if(t)await api().signOut(t,scope).catch(()=>{});
    window.LTSupabaseRealtime?.stop?.();
    write(null);localStorage.removeItem(COMPANY_KEY);
  }
  async function context(){
    let current=read(); if(!current?.access_token)return {authenticated:false};
    current=await refreshIfNeeded(current); if(!current?.access_token)return {authenticated:false,sessionExpired:true};
    const t=current.access_token;
    if(requiresAal2()&&jwtClaims(t).aal!=='aal2')return {authenticated:false,mfaRequired:true};
    let authUser;
    try{authUser=await api().getUser(t)}catch{write(null);return {authenticated:false}}
    const uid=authUser?.id;if(!uid){write(null);return {authenticated:false}}
    const [profiles,memberships,companies]=await Promise.all([
      api().from('app_users',t).select('*','auth_user_id=eq.'+encodeURIComponent(uid)),
      api().from('company_memberships',t).select('*','auth_user_id=eq.'+encodeURIComponent(uid)),
      api().from('companies',t).select('*')
    ]);
    const profile=profiles?.[0]||null;
    if(!profile){
      await api().signOut(t,'global').catch(()=>{});
      write(null);localStorage.removeItem(COMPANY_KEY);
      return {authenticated:false,sessionExpired:true};
    }
    const sessionDurationMinutes=profile.session_duration_minutes===null?null:Number(profile.session_duration_minutes||480);
    const desiredMode=sessionDurationMinutes===null?'session':'local';
    if(storageMode()!==desiredMode)write(current,desiredMode);
    const allowed=new Set((memberships||[]).map(m=>String(m.company_id)));
    const visible=(companies||[]).filter(c=>allowed.has(String(c.id)));
    let companyId=localStorage.getItem(COMPANY_KEY)||'';
    if(!allowed.has(companyId))companyId=visible[0]?.id||'';
    if(companyId)localStorage.setItem(COMPANY_KEY,companyId);
    const company=visible.find(c=>String(c.id)===String(companyId))||visible[0]||null;
    const membership=(memberships||[]).find(m=>String(m.company_id)===String(company?.id))||null;
    const result={
      authenticated:true,
      accessToken:t,
      authUser,
      user:{id:profile.id||uid,authUserId:uid,username:profile.username||authUser.email||'',displayName:profile.display_name||profile.username||authUser.email||'Användare'},
      sessionDurationMinutes,
      company:company?{id:company.id,name:company.display_name||company.legal_name||'Företaget',legalName:company.legal_name,orgNumber:company.org_number}:null,
      membership,
      companies:visible.map(c=>({id:c.id,name:c.display_name||c.legal_name||'Företaget'}))
    };
    window.LTSupabaseRealtime?.autoSync?.(result);
    return result;
  }
  function setCompany(id){localStorage.setItem(COMPANY_KEY,String(id||''))}
  window.LTSupabaseUat={read,token,storeSession,signIn,signOut,context,setCompany};
})();
