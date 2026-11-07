const DEFAULT_MODEL="gemini-3.1-flash-image";
const MAX_IMAGE_BYTES=10*1024*1024;
export async function generateGeminiImage({prompt,apiKey,model=DEFAULT_MODEL,fetchImpl=fetch}){
 if(!apiKey)throw new Error("Gemini API key is not configured");
 if(typeof prompt!=="string"||prompt.trim().length<20||prompt.length>2000)throw new Error("Image prompt must be between 20 and 2000 characters");
 if(!/^[a-zA-Z0-9.-]{3,100}$/.test(model))throw new Error("Invalid Gemini image model");
 const response=await fetchImpl("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+":generateContent",{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":apiKey},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt.trim()}]}],generationConfig:{responseModalities:["TEXT","IMAGE"]}}),signal:AbortSignal.timeout(60000)});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok){const error=new Error(response.status===429?"Gemini rate limit reached. Try again later.":response.status>=500?"Gemini image generation is temporarily unavailable.":"Gemini rejected the request. Check API key, model access and billing.");error.status=response.status===429?429:502;throw error}
 const part=(payload.candidates?.[0]?.content?.parts||[]).find(p=>p.inlineData?.data&&/^image\/(png|jpeg|webp)$/.test(p.inlineData.mimeType||""));
 if(!part){const error=new Error("Gemini returned no supported image.");error.status=502;throw error}
 const bytes=Buffer.from(part.inlineData.data,"base64");if(!bytes.length||bytes.length>MAX_IMAGE_BYTES){const error=new Error("Generated image exceeded the 10 MB preview limit.");error.status=502;throw error}
 return {mimeType:part.inlineData.mimeType,base64:part.inlineData.data,model,sizeBytes:bytes.length};
}
export {DEFAULT_MODEL};
