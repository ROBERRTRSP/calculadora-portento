// Cloudflare Worker for Porcento. Set OPENAI_API_KEY as an encrypted secret.
// Set ALLOWED_ORIGIN to https://roberrtrsp.github.io (optional).
export default {
 async fetch(request, env) {
  const origin=request.headers.get("Origin")||"";
  const allowed=env.ALLOWED_ORIGIN||"https://roberrtrsp.github.io";
  const headers={"Access-Control-Allow-Origin":allowed,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Vary":"Origin","Content-Type":"application/json"};
  if(origin!==allowed) return new Response(JSON.stringify({error:"Origen no autorizado"}),{status:403,headers});
  if(request.method==="OPTIONS")return new Response(null,{headers});
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
