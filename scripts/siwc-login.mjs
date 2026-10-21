#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { access, mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';

const AUTHORIZATION_ENDPOINT='https://auth.openai.com/oauth/authorize';
const TOKEN_ENDPOINT='https://auth.openai.com/api/accounts/oauth/token';
const REDIRECT_URI='http://127.0.0.1:1455/auth/callback';
const OUTPUT=resolve(process.argv[2]??join(homedir(),'.config','mural','siwc-credentials.json'));
const hostID=process.argv[3];
const REQUIRED_SCOPES=['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'];

function fail(message){console.error(message);process.exit(1);}
if(!hostID||!/^urn:uuid:[a-f0-9-]{36}$/i.test(hostID))fail('Usage: node scripts/siwc-login.mjs [credential-file] <server-host-id>');
const state=randomBytes(32).toString('base64url');
const nonce=randomBytes(32).toString('base64url');
const verifier=randomBytes(32).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');

let previous=null;
try { await access(OUTPUT);previous=JSON.parse(await readFile(OUTPUT,'utf8')); }
catch(error){if(error?.code!=='ENOENT')fail('The existing SIWC credentials file could not be read as valid JSON.');}
if(previous&&previous.ext_agent_host_id!==hostID)fail('The existing credentials file belongs to another Mural server host ID.');
const clientID=previous?.client_id??'dynamic_agent_client';
const authorize=new URL(AUTHORIZATION_ENDPOINT);
for(const [key,value] of Object.entries({client_id:clientID,redirect_uri:REDIRECT_URI,response_type:'code',scope:REQUIRED_SCOPES.join(' '),
  code_challenge:challenge,code_challenge_method:'S256',state,nonce,ext_agent_host_id:hostID,agent_name_hint:'Mural'}))authorize.searchParams.set(key,value);
if(previous?.id_token)authorize.searchParams.set('id_token_hint',previous.id_token);
if(previous?.email)authorize.searchParams.set('login_hint',previous.email);

const server=createServer();
await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(1455,'127.0.0.1',resolveListen);});
console.log('Open this URL in a browser signed in to the ChatGPT account used for Mural:');
console.log(authorize.href);
console.log('Waiting for the sign-in callback on http://127.0.0.1:1455 …');

const result=await new Promise((resolveResult,rejectResult)=>{
  let finished=false;
  const finish=(error,value)=>{if(finished)return;finished=true;server.close();error?rejectResult(error):resolveResult(value);};
  server.on('request',async(request,response)=>{
    if(request.socket.remoteAddress!=='127.0.0.1'&&request.socket.remoteAddress!=='::ffff:127.0.0.1'){
      response.writeHead(403);response.end('Use the local Mural sign-in window.');return;
    }
    const callback=new URL(request.url??'/',REDIRECT_URI);
    if(callback.pathname!=='/auth/callback'){response.writeHead(404);response.end('Not found.');return;}
    if(callback.searchParams.get('state')!==state){response.writeHead(400);response.end('Sign-in state check failed.');finish(new Error('Sign-in state check failed.'));return;}
    const providerError=callback.searchParams.get('error');
    if(providerError){response.writeHead(400);response.end('Mural sign-in was cancelled or denied.');finish(new Error('ChatGPT did not grant SIWC access.'));return;}
    const code=callback.searchParams.get('code');
    const issuedClientID=callback.searchParams.get('client_id')??(previous?clientID:null);
    if(!code||!issuedClientID||issuedClientID==='dynamic_agent_client'||(previous&&issuedClientID!==clientID)){
      response.writeHead(400);response.end('The Mural sign-in response was incomplete.');finish(new Error('The sign-in response did not include the issued client ID.'));return;
    }
    try {
      const tokenResponse=await fetch(TOKEN_ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
        headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'authorization_code',client_id:issuedClientID,code,code_verifier:verifier,redirect_uri:REDIRECT_URI,
          resource:'https://api.openai.com/v1'})});
      const raw=await tokenResponse.text();if(raw.length>100_000)throw new Error('The token response exceeded its size limit.');
      let tokens;try{tokens=JSON.parse(raw);}catch{throw new Error('The token response was invalid.');}
      if(!tokenResponse.ok||typeof tokens.access_token!=='string'||typeof tokens.refresh_token!=='string'||typeof tokens.id_token!=='string'||
         !Number.isSafeInteger(tokens.expires_in)||tokens.expires_in<=0||tokens.token_type!=='Bearer')throw new Error('ChatGPT did not return complete SIWC credentials.');
      const scopes=typeof tokens.scope==='string'?tokens.scope.split(/\s+/).filter(Boolean):REQUIRED_SCOPES;
      if(REQUIRED_SCOPES.some(scope=>!scopes.includes(scope)))throw new Error('The ChatGPT account did not grant the required direct token scope.');
      const claims=JSON.parse(Buffer.from(tokens.id_token.split('.')[1]??'','base64url').toString('utf8'));
      if(typeof claims.sub!=='string'||typeof claims.email!=='string'||claims.nonce!==nonce||
         !(claims.email_verified===true||claims.email_verified==='true'))throw new Error('The ChatGPT identity response could not be validated.');
      const credential={client_id:issuedClientID,ext_agent_host_id:hostID,subject:claims.sub,email:claims.email,id_token:tokens.id_token,
        access_token:tokens.access_token,refresh_token:tokens.refresh_token,expires_at:new Date(Date.now()+tokens.expires_in*1000).toISOString(),
        scopes,nonce,token_type:'Bearer'};
      await mkdir(dirname(OUTPUT),{recursive:true,mode:0o700});
      const temp=`${OUTPUT}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temp,JSON.stringify(credential,null,2)+'\n',{flag:'wx',mode:0o600});
      try{await rename(temp,OUTPUT);}catch(error){
        const {unlink}=await import('node:fs/promises');await unlink(temp).catch(()=>{});
        throw new Error(error?.code==='EEXIST'||error?.code==='EPERM'?'Could not safely replace the existing credential file; move it aside and retry.':'Could not save the credentials file.');
      }
      if(process.platform!=='win32')await chmod(OUTPUT,0o600);
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});
      response.end('<!doctype html><title>Mural sign-in complete</title><p>Mural sign-in completed. You can close this page.</p>');
      finish(null,credential.email);
    }catch(error){response.writeHead(500,{'Cache-Control':'no-store'});response.end('Mural could not finish sign-in. Check the local terminal for a safe error summary.');finish(error);}
  });
  process.once('SIGINT',()=>finish(new Error('Sign-in cancelled.')));
});

console.log(`Credentials saved locally for ${result}.`);
console.log(`File: ${OUTPUT}`);
console.log('Transfer this file over SSH using the web-app setup guide. Do not commit it or paste its contents into a terminal.');
