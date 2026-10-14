// Test double for the Supabase client: a "server" table kept in localStorage, password "pw".
(function(){
  const KEY='fake-server', SKEY='fake-session';
  const load=()=>JSON.parse(localStorage.getItem(KEY)||'{}'), save=s=>localStorage.setItem(KEY,JSON.stringify(s));
  window.__server={rows:()=>load(), calls:[]};
  window.__fail=false;
  const handlers=[];
  window.__remote=(eventType,row)=>{ const s=load(); const k=row.owner+'|'+row.path; if(eventType==='DELETE') delete s[k]; else s[k]=row; save(s); handlers.forEach(h=>h({eventType,new:eventType==='DELETE'?{}:row,old:eventType==='DELETE'?{owner:row.owner,path:row.path}:{}})); };
  const fail=()=>window.__fail?{data:null,error:{message:'Failed to fetch'}}:null;
  function table(){
    const q={filters:[],op:'select'};
    const api={
      select(){q.op='select';return api}, eq(f,v){q.filters.push(r=>r[f]===v);return api}, in(f,vs){q.filters.push(r=>vs.includes(r[f]));return api},
      order(f){q.order=f;return api}, range(a,b){q.range=[a,b];return api},
      upsert(rows){q.op='upsert';q.rows=rows;return api}, delete(){q.op='delete';return api},
      then(res,rej){ return new Promise(r=>setTimeout(r,20)).then(()=>{ window.__server.calls.push(q.op+':'+(q.rows?q.rows.length:'')); const f=fail(); if(f) return f;
        const s=load();
        if(q.op==='upsert'){ for(const r of q.rows){ s[r.owner+'|'+r.path]=JSON.parse(JSON.stringify(r)); } save(s); return {data:null,error:null}; }
        let rows=Object.values(s).filter(r=>q.filters.every(fn=>fn(r)));
        if(q.op==='delete'){ for(const r of rows) delete s[r.owner+'|'+r.path]; save(s); return {data:null,error:null}; }
        rows.sort((a,b)=>a.path.localeCompare(b.path)); if(q.range) rows=rows.slice(q.range[0],q.range[1]+1);
        return {data:rows.map(r=>({path:r.path,data:r.data})),error:null}; }).then(res,rej); }
    };
    return api;
  }
  window.supabase={createClient(url,key){ return {
    auth:{ async getSession(){ const s=JSON.parse(localStorage.getItem(SKEY)||'null'); return {data:{session:s}}; },
      async signInWithPassword({email,password}){ if(password!=='pw') return {data:{},error:{message:'Invalid login credentials'}}; const s={user:{id:'u-1',email}}; localStorage.setItem(SKEY,JSON.stringify(s)); return {data:{session:s},error:null}; },
      async signOut(){ localStorage.removeItem(SKEY); return {error:null}; } },
    from(){ return table(); },
    channel(){ const ch={ on(t,f,h){ handlers.push(h); return ch; }, subscribe(cb){ setTimeout(()=>cb&&cb('SUBSCRIBED'),30); return ch; } }; return ch; }
  }; }};
})();
