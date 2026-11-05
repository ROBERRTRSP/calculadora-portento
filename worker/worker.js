
// GET /prices?upc=...&name=... — cloud shopping lookup. Requires SERPAPI_API_KEY secret.
// Search results are candidate offers, NOT proof that the merchant sells the exact UPC.
async function cloudPrices(request, env, headers) {
 const u=new URL(request.url),upc=(u.searchParams.get("upc")||"").trim();
 const name=(u.searchParams.get("name")||"").trim().slice(0,100);
 const json=(body,status=200,cache=false)=>new Response(JSON.stringify(body),{status,headers:{...headers,"Cache-Control":cache?"public, max-age=86400":"no-store"}});
 if(!/^\d{8,14}$/.test(upc))return json({error:"Código UPC/EAN inválido"},400);
 if(!env.SERPAPI_API_KEY)return json({error:"Falta configurar SERPAPI_API_KEY en Cloudflare. La búsqueda web comercial todavía no está activada.",setup_required:true},503);
 const normalized=new URL(request.url);normalized.search="";normalized.searchParams.set("upc",upc);if(name)normalized.searchParams.set("name",name);
 const cacheKey=new Request(normalized.toString(),{method:"GET"});
 const cache=typeof caches!=="undefined"?caches.default:null;
 if(cache){try{const hit=await cache.match(cacheKey);if(hit)return hit}catch{}}
 const call=async(q)=>{
  const p=new URLSearchParams({engine:"google_shopping",q,gl:"us",hl:"en",location:"Paterson, New Jersey, United States",num:"30",api_key:env.SERPAPI_API_KEY});
  const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),12000);
  try{const res=await fetch("https://serpapi.com/search.json?"+p.toString(),{signal:ctrl.signal,headers:{Accept:"application/json"}});const data=await res.json();if(!res.ok||data.error)throw Error(data.error||"No se pudo consultar Google Shopping");
   return Array.isArray(data.shopping_results)?data.shopping_results:[]
  }finally{clearTimeout(timeout)}
 };
 try{
  let rows=await call(upc);
  // A second, name-based search is used only when the exact-code search returns nothing.
  if(!rows.length&&name)rows=await call(name);
  const offers=[],seen=new Set();
  for(const r of rows){
   const price=Number(r.extracted_price),title=String(r.title||"").trim().slice(0,180);
   const seller=String(r.source||"Vendedor sin identificar").trim().slice(0,100);
   const link=String(r.product_link||"");
   if(!Number.isFinite(price)||price<=0||price>100000||!title||!/^https:\/\/[^\s]+$/i.test(link)||r.installment||r.second_hand_condition)continue;
   const rawPrice=String(r.price||"");
   if(/\/\s*(mo|month|week|yr|year)/i.test(rawPrice))continue;
   const exact=(title+" "+String(r.snippet||"")).includes(upc);
   // Name-based results are candidates. Never mark unverified titles as exact UPC matches.
   const k=seller.toLowerCase()+"|"+title.toLowerCase()+"|"+price.toFixed(2);
   if(seen.has(k))continue;seen.add(k);
   offers.push({title,seller,price:Math.round(price*100)/100,url:link,exact_upc_in_listing:exact,match:exact?"UPC en anuncio":"Verificar UPC y tamaño",source:"Google Shopping"});
  }
  offers.sort((a,b)=>a.price-b.price);
  const result=json({upc,offers:offers.slice(0,30),searched_at:new Date().toISOString(),provider:"Google Shopping / SerpApi",location:"Paterson, NJ (búsqueda orientativa)",warning:"Los precios pueden cambiar o incluir otros tamaños, paquetes y vendedores externos. Verifica UPC, presentación, impuestos, envío y disponibilidad antes de usar la comparación."},200,true);
  if(cache)try{await cache.put(cacheKey,result.clone())}catch{}
  return result;
 }catch(err){return json({error:"La búsqueda comercial en la nube falló",detail:String(err.message||err).slice(0,180)},502)}
}

// Cloudflare Worker for Porcento. Set OPENAI_API_KEY as an encrypted secret.
// Set ALLOWED_ORIGIN to https://roberrtrsp.github.io (optional).
export default {
 async fetch(request, env) {
  const origin=request.headers.get("Origin")||"";
  const allowed=env.ALLOWED_ORIGIN||"https://roberrtrsp.github.io";
  const headers={"Access-Control-Allow-Origin":allowed,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Vary":"Origin","Content-Type":"application/json"};
  if(origin!==allowed) return new Response(JSON.stringify({error:"Origen no autorizado"}),{status:403,headers});
  if(request.method==="OPTIONS")return new Response(null,{headers});
  if(new URL(request.url).pathname==="/prices"){if(request.method!=="GET")return new Response(JSON.stringify({error:"Usa GET /prices"}),{status:405,headers});return cloudPrices(request,env,headers)}
  if(request.method!=="POST")return new Response(JSON.stringify({error:"Método no permitido"}),{status:405,headers});
  if(!env.OPENAI_API_KEY)return new Response(JSON.stringify({error:"Falta configurar OPENAI_API_KEY en el servidor"}),{status:503,headers});
  const length=Number(request.headers.get("content-length")||0);
  if(length>9_000_000)return new Response(JSON.stringify({error:"Imagen demasiado grande"}),{status:413,headers});
  try {
   const body=await request.json();
   if(!body.image||!/^data:image\/(jpeg|png|webp);base64,/.test(body.image)||body.image.length>9_000_000)throw Error("Envía una imagen JPEG, PNG o WebP válida, máximo 6 MB");
   const prompt=`Lee la factura como tabla, no como líneas sueltas. Devuelve SOLO JSON con forma {"proveedor":"","productos":[{"nombre":"","cantidad_comprada":1,"unidades_por_empaque":12,"precio_unitario":1.26,"precio_empaque":15.07,"total_linea":15.07,"costo_unitario":1.2558,"confianza":"alta","observacion":""}],"observaciones":[]}. Diferencia QTY comprada, UNIT PRICE, PRICE por caja, EXT PRICE y CASE12/CASE24. La cantidad de unidades por empaque se obtiene de CASE12, 24/12oz, etc. Si QTY=2 y CASE6, son dos cajas de 6, no 2 unidades. Precio unitario y precio empaque pueden ser diferentes por redondeo. costo_unitario = total_linea/(cantidad_comprada*unidades_por_empaque) solo cuando todo esté claro. No inventes cifras: usa null en valores dudosos. No incluyas subtotales, impuestos, promociones ni encabezados como productos. Si aparecen comparaciones "Compare at" o "You saved" ignóralas. Cuando una fila indica 24 un a $3 cada una y total $72, costo_unitario=3 y unidades_por_empaque=1, cantidad_comprada=24. Conserva todos los productos de la factura. Marca confianza baja cuando falten datos.`;
   const response=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:env.OPENAI_MODEL||"gpt-4.1-mini",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:prompt},{role:"user",content:[{type:"text",text:"Extrae los productos y valida los cálculos. Si un dato es incierto, null."},{type:"image_url",image_url:{url:body.image,detail:"high"}}]}],max_tokens:4500})});
   const data=await response.json();
   if(!response.ok)return new Response(JSON.stringify({error:"Error del proveedor de IA",detail:data.error?.message||"Inténtalo de nuevo"}),{status:502,headers});
   const parsed=JSON.parse(data.choices?.[0]?.message?.content||"{}");
   if(!Array.isArray(parsed.productos))throw Error("Respuesta sin productos");
   return new Response(JSON.stringify(parsed),{headers});
  }catch(err){return new Response(JSON.stringify({error:String(err.message||err)}),{status:400,headers})}
 }
};
