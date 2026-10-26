
(async()=>{
 const out={ controllerAtStart: !!navigator.serviceWorker.controller, steps:[] }; window.__out=out
 const reg=await navigator.serviceWorker.register('/site/sw-marker.js',{scope:'/site/'})
 await navigator.serviceWorker.ready
 await new Promise(r=>{ if(navigator.serviceWorker.controller) r(); else navigator.serviceWorker.addEventListener('controllerchange',()=>r(),{once:true}); setTimeout(r,3000) })
 out.controllerAfterReady=!!navigator.serviceWorker.controller
 const early=performance.getEntriesByType('resource').map(e=>e.name.split('/').pop()+':'+e.workerStart)
 out.resourcesLoadedBeforeSW=early
 const r=await fetch('/site/app.css?late=1'); out.lateFetchViaSW = r.headers.get('x-sw')==='1'
 out.done=true
})().catch(e=>{window.__out={error:String(e)}})
