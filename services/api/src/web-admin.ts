import { readFile } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { connectDatabase, transaction } from './db.js';
import { ServiceError } from './errors.js';
import { encryptWebSecret } from './web-secrets.js';
import type { SIWCCredentials } from './web-siwc.js';

const ISSUER = 'https://auth.openai.com';
const JWKS = createRemoteJWKSet(new URL('https://auth.openai.com/.well-known/jwks.json'));
const REQUIRED_SCOPES = ['chatgpt.tokens.use.direct','offline_access','resource.invoke'];
const uuidURN = /^urn:uuid:[a-f0-9-]{36}$/i;

async function hostID() {
  const db=connectDatabase(process.env.DATABASE_URL??'');
  try { const value=(await db.query('SELECT ext_agent_host_id FROM web_host_identity WHERE singleton')).rows[0]?.ext_agent_host_id;
    if(typeof value!=='string')throw new ServiceError('web_host_identity_missing',503);console.log(value); }
  finally { await db.end(); }
}

function object(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function assertKeys(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).some(key=>!keys.includes(key)))throw new ServiceError('invalid_siwc_import');}

async function importSIWC(path:string) {
  const ownerEmail=(process.env.MURAL_WEB_OWNER_EMAIL??'').trim().toLowerCase();
  if(!ownerEmail)throw new ServiceError('web_owner_not_configured',503);
  const db=connectDatabase(process.env.DATABASE_URL??'');
  try {
    const file=await readFile(path); if(file.byteLength>100_000)throw new ServiceError('invalid_siwc_import');
    let parsed:unknown;try{parsed=JSON.parse(file.toString('utf8'));}catch{throw new ServiceError('invalid_siwc_import');}
    if(!object(parsed))throw new ServiceError('invalid_siwc_import');
    assertKeys(parsed,['client_id','ext_agent_host_id','subject','email','id_token','access_token','refresh_token','expires_at','scopes','nonce','token_type']);
    const record=parsed as Record<string,unknown>;
    const requiredString=(key:string,max=16_384)=>{const value=record[key];if(typeof value!=='string'||!value||value.length>max)throw new ServiceError('invalid_siwc_import');return value;};
    const clientID=requiredString('client_id',255),expectedNonce=requiredString('nonce',256),extAgentHostID=requiredString('ext_agent_host_id',50);
    const idToken=requiredString('id_token'),accessToken=requiredString('access_token'),refreshToken=requiredString('refresh_token',4096);
    const email=requiredString('email',254).trim().toLowerCase(),subject=requiredString('subject',255);
    if(clientID==='dynamic_agent_client'||!clientID.startsWith('oaiapp_')||!uuidURN.test(extAgentHostID)||record.token_type!=='Bearer'||
      !Array.isArray(record.scopes)||record.scopes.some(scope=>typeof scope!=='string'))throw new ServiceError('invalid_siwc_import');
    const scopes=(record.scopes as string[]).filter((scope,index,array)=>array.indexOf(scope)===index);
    if(REQUIRED_SCOPES.some(scope=>!scopes.includes(scope)))throw new ServiceError('siwc_plan_access_missing',403);
    const expiresAt=new Date(String(record.expires_at));if(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now())throw new ServiceError('siwc_credentials_expired',401);

    const currentHost=(await db.query('SELECT ext_agent_host_id FROM web_host_identity WHERE singleton')).rows[0]?.ext_agent_host_id;
    if(currentHost!==extAgentHostID)throw new ServiceError('siwc_host_id_mismatch',409);
    const {payload:idClaims}=await jwtVerify(idToken,JWKS,{issuer:ISSUER,audience:clientID,algorithms:['RS256'],clockTolerance:5,
      requiredClaims:['sub','exp','iat','nonce']});
    if(idClaims.nonce!==expectedNonce||idClaims.sub!==subject||typeof idClaims.email!=='string'||idClaims.email.toLowerCase()!==email||
      !(idClaims.email_verified===true||idClaims.email_verified==='true')||email!==ownerEmail)throw new ServiceError('siwc_identity_mismatch',403);
    const {payload:accessClaims}=await jwtVerify(accessToken,JWKS,{issuer:ISSUER,audience:'https://api.openai.com/v1',algorithms:['RS256'],clockTolerance:5,
      requiredClaims:['sub','exp','iat']});
    const accessScopes=typeof accessClaims.scope==='string'?accessClaims.scope.split(/\s+/):[];
    if(accessClaims.sub!==subject||accessClaims.client_id!==clientID||REQUIRED_SCOPES.some(scope=>!accessScopes.includes(scope))||
      accessScopes.some(scope=>!scopes.includes(scope)))throw new ServiceError('siwc_plan_access_missing',403);
    const expiresFromToken=typeof accessClaims.exp==='number'?accessClaims.exp*1000:0;
    if(!expiresFromToken||Math.abs(expiresFromToken-expiresAt.getTime())>5*60_000)throw new ServiceError('siwc_expiry_mismatch',400);
    const accountRows=(await db.query(`SELECT id FROM accounts WHERE lower(email)=lower($1) AND deleted_at IS NULL AND NOT is_guest`,[ownerEmail])).rows;
    if(accountRows.length!==1)throw new ServiceError(accountRows.length?'web_owner_account_ambiguous':'web_owner_sign_in_required',409);
    const accountID=accountRows[0]!.id as string;
    const credentials:SIWCCredentials={client_id:clientID,ext_agent_host_id:extAgentHostID,subject,email,id_token:idToken,access_token:accessToken,
      refresh_token:refreshToken,expires_at:expiresAt.toISOString(),scopes,token_type:'Bearer'};
    const encrypted=encryptWebSecret(credentials,'siwc',accountID);
    await transaction(db,async sql=>{
      await sql.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountID]);
      await sql.query(`INSERT INTO web_siwc_credentials(account_id,client_id,subject,email,scopes,access_token_expires_at,nonce,ciphertext,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id) DO UPDATE SET client_id=excluded.client_id,
        subject=excluded.subject,email=excluded.email,scopes=excluded.scopes,access_token_expires_at=excluded.access_token_expires_at,
        nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at=now()`,
        [accountID,clientID,subject,email,scopes,expiresAt,encrypted.nonce,encrypted.ciphertext,encrypted.authTag]);
    });
    console.log(`SIWC ChatGPT plan credentials installed for ${email}.`);
  } finally { await db.end(); }
}

const [command,...args]=process.argv.slice(2);
try {
  if(command==='host-id'&&args.length===0)await hostID();
  else if(command==='import-siwc'&&args.length===1)await importSIWC(args[0]!);
  else { console.error('Usage: web-admin.js host-id | import-siwc <credential-file>');process.exitCode=2; }
} catch(error) {
  const code=error instanceof ServiceError?error.code:'web_admin_failed';
  console.error(`Mural web admin command failed (${code}).`);process.exitCode=1;
}
