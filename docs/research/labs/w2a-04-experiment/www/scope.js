
(async()=>{ const out={}; window.__out=out
 const t=async(label,url,opts)=>{ try{ const r=await navigator.serviceWorker.register(url,opts); out[label]={ok:true,scope:r.scope}; await r.unregister() }catch(e){ out[label]={ok:false,name:e.name,msg:String(e.message).slice(0,200)} } }
 await t('blogSW_defaultScope','/blog/sw.js')
 await t('blogSW_scopeRoot_noHeader','/blog/sw.js',{scope:'/'})
 await t('blog2SW_scopeRoot_withHeader','/blog2/sw.js',{scope:'/'})
 await t('rootPath_scopeBlog','/blog/sw.js',{scope:'/blog/sub/'})
 out.done=true })()
