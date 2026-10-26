import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { api, explainError } from './api';
import type { AISettings, Bootstrap, Conversation, FullConversation, Message, Preferences, View, VoiceBudget, VocabularyItem } from './types';

declare global { interface Window { google?: any } }

const languages = [
  ['nb-NO','Norwegian','Norsk'],['es-ES','Spanish','Español'],['en-US','English','English'],['fr-FR','French','Français'],
  ['de-DE','German','Deutsch'],['it-IT','Italian','Italiano'],['pt-BR','Portuguese','Português'],['zh-CN','Mandarin','中文'],
  ['sr-Latn-RS','Serbian','Srpski'],['el-GR','Greek','Ελληνικά'],['tl-PH','Tagalog','Tagalog'],['nl-NL','Dutch','Nederlands'],['ru-RU','Russian','Русский']
] as const;
const meaningLanguages = ['English','French','German','Spanish','Norwegian','Portuguese','Italian','Chinese (Simplified)','Polish','Arabic','Ukrainian','Serbian (Latin)','Greek','Tagalog (Filipino)','Dutch','Russian'];
const themes = [
  ['introductions','Nice to meet you','Start somewhere small'],['coffee','A coffee?','Something warm, please'],['weekend','The weekend','Tell me about yours'],
  ['walk','A little walk','Out into the fresh air'],['dinner','Dinner plans','Let’s make something'],['groceries','At the market','Find the good tomatoes'],
  ['travel','Next stop','A ticket to somewhere'],['home','A place of your own','Make yourself at home'],['friends','New friends','An invitation, maybe'],
  ['work','Monday morning','Around the office'],['weather','Rain again?','Whatever the weather'],['cabin','A weekend away','A quieter kind of day'],
  ['music','On repeat','What are you listening to?'],['film','One more episode','Something worth watching'],['books','Between the pages','A story that stayed'],
  ['design','Good things','Made with a little care'],['technology','What comes next','Ideas, tools and tomorrow'],['travelstories','Somewhere else','A place you remember'],
  ['restaurant','A table for two','Stay for dessert'],['neighbours','Next door','A familiar face'],['traditions','Everyday customs','Small customs, big stories'],
  ['opinions','What do you think?','Room for another view'],['future','A year from now','Plans worth talking about'],['today','The world today','Something to talk about']
] as const;

function languageName(id: string) { return languages.find(item => item[0] === id)?.[1] ?? 'Norwegian'; }
function languageGreeting(id: string) { return ({'nb-NO':'Hei!','es-ES':'¡Hola!','en-US':'Hi!','fr-FR':'Salut !','de-DE':'Hallo!','it-IT':'Ciao!','pt-BR':'Olá!','zh-CN':'你好！','sr-Latn-RS':'Zdravo!','el-GR':'Γεια σου!','tl-PH':'Kumusta!','nl-NL':'Hoi!','ru-RU':'Привет!'} as Record<string,string>)[id]??'Hi!'; }
function themeName(id: string) { return themes.find(item => item[0] === id)?.[1] ?? 'Nice to meet you'; }
function formatDate(date: string) { return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(date)); }
function formatMinutes(ms: number) { return `${Math.max(0, Math.floor(ms / 60_000))} min`; }

async function loadGoogleScript() {
  if (window.google?.accounts?.id) return;
  await new Promise<void>((resolve,reject)=>{
    const existing=document.querySelector<HTMLScriptElement>('script[data-google-identity]');
    if(existing){existing.addEventListener('load',()=>resolve(),{once:true});existing.addEventListener('error',()=>reject(new Error('google_script_failed')),{once:true});return;}
    const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.defer=true;script.dataset.googleIdentity='true';
    script.onload=()=>resolve();script.onerror=()=>reject(new Error('google_script_failed'));document.head.append(script);
  });
}

export function App() {
  const [email,setEmail]=useState<string|null>(null);
  const [authReady,setAuthReady]=useState(false);
  const [data,setData]=useState<Bootstrap|null>(null);
  const [view,setView]=useState<View>('talk');
  const [conversation,setConversation]=useState<FullConversation|null>(null);
  const [error,setError]=useState('');
  const [working,setWorking]=useState(false);
  const [voiceActive,setVoiceActive]=useState(false);
  const [voiceSessionID,setVoiceSessionID]=useState<string|null>(null);
  const [livePartial,setLivePartial]=useState('');
  const [notice,setNotice]=useState('');
  const pcRef=useRef<RTCPeerConnection|null>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const channelRef=useRef<RTCDataChannel|null>(null);
  const sessionRef=useRef<string|null>(null);
  const partialRef=useRef<Map<string,string>>(new Map());
  const completedResponsesRef=useRef<Set<string>>(new Set());
  const audioRef=useRef<HTMLAudioElement>(null);

  const refresh = useCallback(async () => {
    const result=await api<Bootstrap>('/v1/web/bootstrap'); setData(result);
    return result;
  },[]);
  const loadConversation=useCallback(async (conversationID:string) => {
    const result=await api<FullConversation>(`/v1/web/conversations/${conversationID}`);setConversation(result);setView('talk');
  },[]);

  useEffect(()=>{
    let active=true;
    api<{email:string}>('/v1/web/auth/session').then(async result=>{
      if(!active)return;setEmail(result.email);const initial=await refresh();
      const recent=initial.conversations.find(item=>item.languageID===initial.preferences.languageID);
      if(active&&recent) await loadConversation(recent.id);
    }).catch(()=>{if(active)setEmail(null);}).finally(()=>{if(active)setAuthReady(true);});
    return()=>{active=false;};
  },[loadConversation,refresh]);

  useEffect(()=>{document.documentElement.dataset.theme=data?.preferences.colorScheme??'system';},[data?.preferences.colorScheme]);
  useEffect(()=>{
    if(!voiceActive||!voiceSessionID)return;
    const timer=window.setInterval(()=>{
      api<VoiceBudget>('/v1/web/voice/budget').then(budget=>setData(current=>current?{...current,voice:{...current.voice,...budget}}:current)).catch(()=>{});
    },15_000);
    return()=>window.clearInterval(timer);
  },[voiceActive,voiceSessionID]);

  const updateMessage=(message:Message)=>setConversation(current=>current?{
    ...current,messages:[...(current.messages??[]).filter(item=>item.id!==message.id),message]
  }:current);

  const appendLiveMessage=useCallback(async(role:'user'|'assistant',content:string)=>{
    if(!content.trim()||!sessionRef.current||!conversation)return;
    try{
      const saved=await api<Message>(`/v1/web/conversations/${conversation.id}/messages`,{method:'POST',body:JSON.stringify({role,content:content.trim()})});
      updateMessage(saved); setData(current=>current?{...current,conversations:current.conversations.map(item=>item.id===conversation.id?{...item,updatedAt:saved.createdAt,messageCount:(item.messageCount??0)+1}:item)}:current);
    }catch{setError('Could not save the voice transcript.');}
  },[conversation]);

  const closeVoice=useCallback(async()=>{
    const id=sessionRef.current;
    sessionRef.current=null;setVoiceActive(false);setVoiceSessionID(null);setLivePartial('');channelRef.current?.close();channelRef.current=null;
    pcRef.current?.close();pcRef.current=null;streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;
    if(id){try{await api(`/v1/web/live/sessions/${id}/close`,{method:'POST',body:'{}'});}catch{/* The hosted recovery worker closes sessions if the browser disappears. */}}
    try{const budget=await api<VoiceBudget & {rateUSDPerMinute?:number}>('/v1/web/voice/budget');setData(current=>current?{...current,voice:{...current.voice,...budget}}:current);}catch{/* Keep the last usage estimate visible. */}
  },[]);

  const receiveLiveEvent=useCallback((raw:string)=>{
    let event:any;try{event=JSON.parse(raw);}catch{return;}
    const responseID=typeof event.response_id==='string'?event.response_id:'current';
    if(event.type==='conversation.item.input_audio_transcription.completed'&&typeof event.transcript==='string'){
      setLivePartial('');void appendLiveMessage('user',event.transcript);return;
    }
    if(event.type==='response.audio_transcript.delta'||event.type==='response.output_audio_transcript.delta'){
      const next=(partialRef.current.get(responseID)??'')+(typeof event.delta==='string'?event.delta:'');partialRef.current.set(responseID,next);setLivePartial(next);return;
    }
    if(event.type==='response.audio_transcript.done'||event.type==='response.output_audio_transcript.done'){
      if(completedResponsesRef.current.has(responseID))return;
      completedResponsesRef.current.add(responseID);const text=typeof event.transcript==='string'?event.transcript:partialRef.current.get(responseID)??'';
      partialRef.current.delete(responseID);setLivePartial('');void appendLiveMessage('assistant',text);return;
    }
    if(event.type==='error'){setError('Voice returned an error. You can still continue by typing.');}
  },[appendLiveMessage]);

  async function startConversation(languageID=data?.preferences.languageID??'nb-NO',themeID=data?.preferences.conversationTheme??'introductions'){
    setError('');setWorking(true);
    try{const created=await api<FullConversation>('/v1/web/conversations',{method:'POST',body:JSON.stringify({languageID,themeID})});
      setConversation(created);setData(current=>current?{...current,conversations:[created,...current.conversations]}:current);setView('talk');}
    catch(e){setError(explainError((e as Error).message));}finally{setWorking(false);}
  }

  async function savePreferences(preferences:Preferences){
    const languageChanged=preferences.languageID!==data?.preferences.languageID;
    if(languageChanged&&sessionRef.current)await closeVoice();
    await api('/v1/web/preferences',{method:'PUT',body:JSON.stringify(preferences)});
    setData(current=>current?{...current,preferences}:current);
    if(languageChanged){
      setConversation(null);
      setNotice(`${languageName(preferences.languageID)} selected. Your previous conversations are in Journal.`);
    }
  }

  async function sendText(text:string){
    if(!conversation||!text.trim()||working)return;
    if(voiceActive){
      if(channelRef.current?.readyState!=='open'){setError('Voice is connecting. Try sending again in a moment.');return;}
      const content=text.trim();const message:Message={id:crypto.randomUUID(),role:'user',content,meaning:null,createdAt:new Date().toISOString()};updateMessage(message);
      channelRef.current.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:content}]}}));
      channelRef.current.send(JSON.stringify({type:'response.create'}));void appendLiveMessage('user',content);return;
    }
    const user:Message={id:crypto.randomUUID(),role:'user',content:text.trim(),meaning:null,createdAt:new Date().toISOString()};
    const tempID=`pending-${crypto.randomUUID()}`,temp:Message={id:tempID,role:'assistant',content:'',meaning:null,createdAt:new Date().toISOString()};
    setConversation(current=>current?{...current,messages:[...(current.messages??[]),user,temp]}:current);setWorking(true);setError('');
    try{
      const response=await fetch(`/v1/web/conversations/${conversation.id}/respond`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text.trim()})});
      if(!response.ok){let code='request_failed';try{code=(await response.json()).error?.code??code;}catch{/* no JSON response */}throw new Error(code);}
      const reader=response.body?.getReader();if(!reader)throw new Error('ai_provider_stream_invalid');const decoder=new TextDecoder();let buffer='';
      const handleFrame=(frame:string)=>{for(const line of frame.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const event=JSON.parse(line.slice(5).trim());
        if(event.type==='delta')setConversation(current=>current?{...current,messages:(current.messages??[]).map(item=>item.id===tempID?{...item,content:item.content+event.text}:item)}:current);
        if(event.type==='done'){setConversation(current=>current?{...current,messages:(current.messages??[]).map(item=>item.id===tempID?event.message:item)}:current);setData(current=>current?{...current,conversations:current.conversations.map(item=>item.id===conversation.id?{...item,title:item.messageCount?item.title:text.trim().slice(0,110),updatedAt:event.message.createdAt,messageCount:(item.messageCount??0)+2}:item)}:current);}
        if(event.type==='error')throw new Error(event.code??'ai_provider_unavailable');
      }};
      for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary:number;
        while((boundary=buffer.search(/\r?\n\r?\n/))!==-1){const frame=buffer.slice(0,boundary);const separator=buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0]??'\n\n';buffer=buffer.slice(boundary+separator.length);handleFrame(frame);}}
      buffer+=decoder.decode();if(buffer.trim())handleFrame(buffer);
    }catch(e){setConversation(current=>current?{...current,messages:(current.messages??[]).filter(item=>item.id!==tempID)}:current);setError(explainError((e as Error).message));}
    finally{setWorking(false);}
  }

  async function startVoice(){
    if(!conversation||!data?.voice.enabled||voiceActive)return;
    setError('');setWorking(true);
    let createdSessionID:string|undefined;
    try{
      const budget=await api<VoiceBudget>('/v1/web/voice/budget');setData(current=>current?{...current,voice:{...current.voice,...budget}}:current);
      if(!budget.enabled||budget.availableMilliseconds<60_000)throw new Error(budget.reason??'voice_monthly_budget_reached');
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('microphone_unavailable');
      const media=await navigator.mediaDevices.getUserMedia({audio:true});streamRef.current=media;
      const pc=new RTCPeerConnection();pcRef.current=pc;media.getTracks().forEach(track=>pc.addTrack(track,media));
      pc.addEventListener('track',event=>{if(audioRef.current){audioRef.current.srcObject=event.streams[0]??new MediaStream([event.track]);void audioRef.current.play().catch(()=>{});}});
      const channel=pc.createDataChannel('oai-events');channelRef.current=channel;channel.onmessage=event=>receiveLiveEvent(event.data);
      channel.onopen=()=>setNotice('You’re connected. Speak naturally, or type a message.');
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      const answer=await api<{sessionID:string;sdp:string}>('/v1/web/live/sessions',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({sdp:offer.sdp,languageID:conversation.languageID,
        history:(conversation.messages??[]).slice(-30).map(message=>({type:'message',role:message.role,content:[{type:message.role==='user'?'input_text':'output_text',text:message.content}]}))})});
      createdSessionID=answer.sessionID;sessionRef.current=answer.sessionID;setVoiceSessionID(answer.sessionID);
      await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});setVoiceActive(true);setNotice('Voice is on. Your monthly limit is $10.');
      const nextBudget=await api<VoiceBudget>('/v1/web/voice/budget');setData(current=>current?{...current,voice:{...current.voice,...nextBudget}}:current);
    }catch(e){if(createdSessionID){sessionRef.current=createdSessionID;await closeVoice();}else{pcRef.current?.close();pcRef.current=null;streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;channelRef.current=null;}
      setError((e as Error).message==='NotAllowedError'?'Allow microphone access in your browser to start voice.':(e as Error).message==='microphone_unavailable'?'This browser does not support microphone access.':explainError((e as Error).message));}
    finally{setWorking(false);}
  }

  async function showMeaning(message:Message){
    if(!conversation)return;setWorking(true);setError('');
    try{const result=await api<{meaning:string}>(`/v1/web/conversations/${conversation.id}/messages/${message.id}/meaning`,{method:'POST',body:'{}'});updateMessage({...message,meaning:result.meaning});}
    catch(e){setError(explainError((e as Error).message));}finally{setWorking(false);}
  }
  async function saveWord(message:Message){
    if(!conversation)return;
    let meaning=message.meaning;
    if(!meaning){try{const result=await api<{meaning:string}>(`/v1/web/conversations/${conversation.id}/messages/${message.id}/meaning`,{method:'POST',body:'{}'});meaning=result.meaning;updateMessage({...message,meaning});}
      catch(e){setError(explainError((e as Error).message));return;}}
    const phrase=window.prompt('Phrase to save',message.content.slice(0,500));if(!phrase?.trim())return;
    try{const item=await api<VocabularyItem>('/v1/web/vocabulary',{method:'POST',body:JSON.stringify({languageID:conversation.languageID,phrase,meaning,sourceConversationID:conversation.id})});
      setData(current=>current?{...current,vocabulary:[item,...current.vocabulary]}:current);setNotice('Saved to your words.');}
    catch(e){setError(explainError((e as Error).message));}
  }

  async function login(){
    setError('');setWorking(true);
    try{
      const cfg=await api<{enabled:boolean;googleClientID:string|null}>('/v1/web/auth/config');if(!cfg.enabled||!cfg.googleClientID)throw new Error('web_auth_not_configured');
      await loadGoogleScript();const challenge=await api<{challengeID:string;nonce:string}>('/v1/web/auth/challenge',{method:'POST',body:'{}'});
      window.google.accounts.id.initialize({client_id:cfg.googleClientID,nonce:challenge.nonce,callback:async(response:{credential:string})=>{
        try{await api('/v1/web/auth/exchange',{method:'POST',body:JSON.stringify({idToken:response.credential,challengeID:challenge.challengeID})});
          const profile=await api<{email:string}>('/v1/web/auth/session');setEmail(profile.email);const initial=await refresh();
          const recent=initial.conversations.find(item=>item.languageID===initial.preferences.languageID);if(recent)await loadConversation(recent.id);}
        catch(e){setError(explainError((e as Error).message));}
      }});
      window.google.accounts.id.prompt();
    }catch(e){setError(explainError((e as Error).message));}finally{setWorking(false);}
  }

  if(!authReady)return <div className="loading-screen"><span className="brand-mark">m</span><p>Opening your space…</p></div>;
  if(!email)return <SignIn error={error} working={working} login={login}/>;
  if(!data)return <div className="loading-screen"><span className="brand-mark">m</span><p>Loading your practice…</p></div>;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#talk" onClick={event=>{event.preventDefault();setView('talk');}}><span className="brand-mark">m</span><span>mural</span></a>
      <nav className="primary-nav" aria-label="Main navigation">
        <NavButton id="talk" active={view==='talk'} onClick={()=>setView('talk')}>Talk</NavButton>
        <NavButton id="journal" active={view==='journal'} onClick={()=>setView('journal')}>Journal</NavButton>
        <NavButton id="words" active={view==='words'} onClick={()=>setView('words')}>Words <span className="nav-count">{data.vocabulary.length}</span></NavButton>
      </nav>
      <button className={`account-pill ${view==='settings'?'selected':''}`} onClick={()=>setView('settings')} aria-label={`Settings for ${email}`}>
        <span className="account-dot" aria-hidden="true"/>{email.split('@')[0]}<span className="chevron">⌄</span>
      </button>
    </header>

    <main className={`main-content ${view==='talk'?'talk-view':`page-view page-${view}`}`}>
      {view==='talk'&&<TalkView data={data} conversation={conversation} startConversation={startConversation}
        onSend={sendText} working={working} voiceActive={voiceActive} startVoice={startVoice} closeVoice={closeVoice} showMeaning={showMeaning}
        saveWord={saveWord} livePartial={livePartial} audioRef={audioRef}/>}
      {view==='journal'&&<JournalView conversations={data.conversations} onOpen={loadConversation} onCreate={()=>startConversation()}
        onDelete={async id=>{if(!window.confirm('Delete this conversation and its transcript?'))return;try{await api(`/v1/web/conversations/${id}`,{method:'DELETE'});
          setData(current=>current?{...current,conversations:current.conversations.filter(item=>item.id!==id)}:current);if(conversation?.id===id)setConversation(null);}
          catch(e){setError(explainError((e as Error).message));}}} />}
      {view==='words'&&<WordsView words={data.vocabulary} onDelete={async id=>{try{await api(`/v1/web/vocabulary/${id}`,{method:'DELETE'});setData(current=>current?{...current,vocabulary:current.vocabulary.filter(item=>item.id!==id)}:current);}
        catch(e){setError(explainError((e as Error).message));}}}/>}
      {view==='settings'&&<SettingsView email={email} data={data} refresh={refresh} onSavePreferences={savePreferences} preferencesDisabled={working} onSignOut={async()=>{await closeVoice();try{await api('/v1/web/auth/sign-out',{method:'POST',body:'{}'});}catch{/* Clear local state even if the server response is lost. */}
        setEmail(null);setData(null);setConversation(null);setView('talk');}} onError={setError}/>}
    </main>
    <div className="toast-region" aria-live="polite">{error&&<div className="toast toast-error"><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error">×</button></div>}
      {!error&&notice&&<div className="toast"><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss message">×</button></div>}</div>
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <NavButton id="talk" active={view==='talk'} onClick={()=>setView('talk')}>◉<span>Talk</span></NavButton>
      <NavButton id="journal" active={view==='journal'} onClick={()=>setView('journal')}>▤<span>Journal</span></NavButton>
      <NavButton id="words" active={view==='words'} onClick={()=>setView('words')}>✳<span>Words</span></NavButton>
      <NavButton id="settings" active={view==='settings'} onClick={()=>setView('settings')}>⚙<span>Settings</span></NavButton>
    </nav>
  </div>;
}

function SignIn({error,working,login}:{error:string;working:boolean;login:()=>void}){
  return <main className="sign-in-screen">
    <div className="sign-in-top"><a className="brand" href="#"><span className="brand-mark">m</span><span>mural</span></a><span className="private-note"><span className="lock-dot">◈</span> private, self-hosted</span></div>
    <section className="sign-in-card"><div className="sign-in-art"><span className="sun-dot"/><div className="art-line art-line-one"/><div className="art-line art-line-two"/><div className="art-caption">little by little</div></div>
      <span className="eyebrow">A LITTLE EVERY DAY</span><h1>Make room for another language.</h1><p className="sign-in-copy">A calm place to practise, keep your new words, and come back whenever you have a moment.</p>
      <button className="google-button" onClick={login} disabled={working}><span className="google-g">G</span>{working?'Preparing secure sign-in…':'Continue with Google'}</button>
      <p className="owner-note">This private instance is limited to its configured owner.</p>{error&&<p className="inline-error" role="alert">{error}</p>}
      <p className="sign-in-foot">Your conversation history stays in your own database.</p>
    </section>
  </main>;
}

function NavButton({id,active,onClick,children}:{id:string;active:boolean;onClick:()=>void;children:ReactNode}){
  return <button className={`nav-button ${active?'active':''}`} onClick={onClick} aria-current={active?'page':undefined} data-view={id}>{children}</button>;
}

function TalkView({data,conversation,startConversation,onSend,working,voiceActive,startVoice,closeVoice,showMeaning,saveWord,livePartial,audioRef}:
  {data:Bootstrap;conversation:FullConversation|null;startConversation:(languageID?:string,themeID?:string)=>Promise<void>;
   onSend:(text:string)=>void;working:boolean;voiceActive:boolean;startVoice:()=>void;closeVoice:()=>void;showMeaning:(message:Message)=>void;saveWord:(message:Message)=>void;
   livePartial:string;audioRef:RefObject<HTMLAudioElement|null>}){
  const [draft,setDraft]=useState('');const scroller=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;},[conversation?.messages?.length,livePartial]);
  function submit(event:FormEvent){event.preventDefault();const value=draft.trim();if(value){setDraft('');onSend(value);}}
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void submit(event as unknown as FormEvent);}}
  const language=languageName(conversation?.languageID??data.preferences.languageID),theme=themeName(conversation?.themeID??data.preferences.conversationTheme);
  return <section className="talk-layout">
    <div className="talk-heading"><div className="talk-heading-copy"><span className="eyebrow">YOUR PRACTICE, YOUR PACE</span><h1>A little everyday {language}</h1>
      <p>{theme}. Come as you are.</p></div><div className="talk-language-chip"><span className="status-dot"/>{language}</div></div>
    {!conversation?<div className="start-card"><div className="orb orb-idle"><span/></div><span className="eyebrow">A SMALL HELLO IS ENOUGH</span><h2>{languageGreeting(data.preferences.languageID)}</h2>
      <p>Start with a familiar moment. Mural will follow your lead and keep the conversation gentle.</p><button className="button button-primary" onClick={()=>void startConversation()} disabled={working}>Start a conversation <span>→</span></button>
      <div className="start-suggestions">{themes.slice(0,3).map(item=><button key={item[0]} onClick={()=>void startConversation(data.preferences.languageID,item[0])}>{item[1]}</button>)}</div></div>
      :<>
        <div className="conversation-meta"><span>{theme}</span><span className="meta-separator">·</span><span>{formatDate(conversation.updatedAt)}</span></div>
        <div className="message-list" ref={scroller} aria-label="Conversation">
          {(conversation.messages??[]).length===0&&<div className="first-message"><div className="orb orb-idle small"><span/></div><p>{languageGreeting(conversation.languageID)} Ready when you are.</p></div>}
          {(conversation.messages??[]).map(message=><MessageBubble key={message.id} message={message} onMeaning={()=>showMeaning(message)} onSave={()=>saveWord(message)} working={working}/>)}
          {livePartial&&<div className="message-row assistant"><div className="message-avatar">m</div><div className="message-body"><p>{livePartial}<span className="typing-cursor"/></p><span className="message-label">Mural · speaking</span></div></div>}
          {working&&!(conversation.messages??[]).some(message=>message.id.startsWith('pending-'))&&<div className="message-row assistant"><div className="message-avatar">m</div><div className="message-body pending-dots"><span/><span/><span/><span className="sr-only">Mural is thinking</span></div></div>}
        </div>
        <div className="composer-wrap">
          {voiceActive&&<div className="voice-status"><span className="recording-dot"/>Voice is on
            <button onClick={()=>void closeVoice()} className="voice-stop">End voice</button></div>}
          <form className="composer" onSubmit={submit}><textarea value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={keyDown}
            placeholder={voiceActive?'Type a message for Mural…':'Write a short reply…'} aria-label="Your message" rows={1} disabled={working&&!voiceActive}/>
            <button className={`mic-button ${voiceActive?'is-live':''}`} type="button" onClick={()=>voiceActive?void closeVoice():void startVoice()} disabled={!data.voice.enabled||working}
              aria-label={voiceActive?'End voice conversation':'Start voice conversation'} title={data.voice.enabled?`Voice, capped at $10 per UTC month`:explainError(data.voice.reason??'voice_provider_not_configured')}>
              {voiceActive?'■':'♩'}
            </button><button className="send-button" type="submit" disabled={!draft.trim()||working&&!voiceActive} aria-label="Send message">↑</button>
          </form>
          <div className="composer-foot"><span>{voiceActive?'Your voice usage is tracked on the server.':'Enter to send · Shift + Enter for a new line'}</span>
            <span className="privacy-mark">⌑ Private</span></div>
        </div>
      </>}
    <audio ref={audioRef} autoPlay className="sr-only" aria-label="Mural voice audio"/>
  </section>;
}

function MessageBubble({message,onMeaning,onSave,working}:{message:Message;onMeaning:()=>void;onSave:()=>void;working:boolean}){
  const assistant=message.role==='assistant';return <article className={`message-row ${assistant?'assistant':'user'}`}>
    {assistant&&<div className="message-avatar">m</div>}<div className="message-body"><p>{message.content||<span className="pending-dots"><span/><span/><span/></span>}</p>
      {assistant&&message.meaning&&<div className="message-meaning"><span>MEANING</span>{message.meaning}</div>}
      <div className="message-footer"><span className="message-label">{assistant?'Mural':'You'} · {formatDate(message.createdAt)}</span>
        {assistant&&<div className="message-actions"><button onClick={onMeaning} disabled={working}>{message.meaning?'Refresh meaning':'Meaning'}</button><button onClick={onSave} disabled={working}>Save phrase</button></div>}</div>
    </div></article>;
}

function JournalView({conversations,onOpen,onCreate,onDelete}:{conversations:Conversation[];onOpen:(id:string)=>void;onCreate:()=>void;onDelete:(id:string)=>void}){
  return <section className="content-page"><div className="page-title-row"><div><span className="eyebrow">YOUR PRACTICE</span><h1>Journal</h1><p>Every conversation, ready when you are.</p></div><button className="button button-primary" onClick={onCreate}>New conversation <span>→</span></button></div>
    {!conversations.length?<div className="empty-card"><span className="empty-icon">◷</span><h2>A fresh page</h2><p>Your conversations will collect here as you practise.</p><button className="text-button" onClick={onCreate}>Begin your first conversation →</button></div>:
      <div className="journal-list">{conversations.map((item,index)=><article className="journal-card" key={item.id}>
        <button className="journal-open" onClick={()=>onOpen(item.id)}><span className={`journal-number tone-${index%4}`}>{String(index+1).padStart(2,'0')}</span><span className="journal-copy">
          <strong>{item.title}</strong><span>{languageName(item.languageID)} <i>·</i> {themeName(item.themeID)}</span></span><span className="journal-date">{formatDate(item.updatedAt)}</span><span className="journal-count">{item.messageCount??0} messages</span><span className="journal-arrow">→</span></button>
        <button className="icon-button delete-button" onClick={()=>onDelete(item.id)} aria-label={`Delete ${item.title}`}>×</button></article>)}</div>}
  </section>;
}

function WordsView({words,onDelete}:{words:VocabularyItem[];onDelete:(id:string)=>void}){
  const grouped=useMemo(()=>words.reduce<Record<string,VocabularyItem[]>>((all,item)=>{(all[item.languageID]??=[]).push(item);return all;},{}),[words]);
  return <section className="content-page"><div className="page-title-row"><div><span className="eyebrow">WORDS THAT STAY</span><h1>Your words</h1><p>Little things you’ve learned, kept close.</p></div><span className="word-total">{words.length} saved</span></div>
    {!words.length?<div className="empty-card"><span className="empty-icon">✳</span><h2>Words take root here</h2><p>Save a phrase from any conversation to see it again later.</p></div>:
      <div className="word-groups">{Object.entries(grouped).map(([language,items])=><section className="word-group" key={language}><h2><span className="language-mark">{languageName(language).slice(0,2).toUpperCase()}</span>{languageName(language)}<span>{items.length}</span></h2>
        <div className="word-grid">{items.map(item=><article className="word-card" key={item.id}><button className="icon-button delete-button" aria-label="Remove saved word" onClick={()=>onDelete(item.id)}>×</button>
          <span className="word-date">{new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(new Date(item.createdAt))}</span><h3>{item.phrase}</h3><p>{item.meaning}</p>{item.note&&<small>{item.note}</small>}</article>)}</div></section>)}</div>}
  </section>;
}

function SettingsView({email,data,refresh,onSavePreferences,preferencesDisabled,onSignOut,onError}:
  {email:string;data:Bootstrap;refresh:()=>Promise<Bootstrap>;onSavePreferences:(preferences:Preferences)=>Promise<void>;preferencesDisabled:boolean;onSignOut:()=>Promise<void>;onError:(message:string)=>void}){
  const [prefs,setPrefs]=useState<Preferences>(data.preferences);const [ai,setAI]=useState<AISettings>(data.ai);const [apiKey,setApiKey]=useState('');
  const [clearKey,setClearKey]=useState(false);const [models,setModels]=useState<string[]>([]);const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [importMode,setImportMode]=useState<'merge'|'replace'>('merge');
  useEffect(()=>{setPrefs(data.preferences);setAI(data.ai);},[data.preferences,data.ai]);
  async function savePreferences(){setBusy(true);setMessage('');try{await onSavePreferences(prefs);setMessage('Preferences saved.');}
    catch(e){onError(explainError((e as Error).message));}finally{setBusy(false);}}
  async function saveAI(){setBusy(true);setMessage('');try{const payload:Record<string,unknown>={provider:ai.provider,apiBase:ai.apiBase,model:ai.model,apiStyle:ai.apiStyle,nativeWebSearch:ai.nativeWebSearch};if(apiKey.trim())payload.apiKey=apiKey.trim();if(clearKey)payload.clearApiKey=true;
      await api('/v1/web/ai/settings',{method:'POST',body:JSON.stringify(payload)});setApiKey('');setClearKey(false);await refresh();setMessage('AI settings saved.');}
    catch(e){onError(explainError((e as Error).message));}finally{setBusy(false);}}
  async function loadModels(){setBusy(true);try{const result=await api<{models:string[]}>('/v1/web/ai/models');setModels(result.models);if(!result.models.includes(ai.model)&&result.models[0])setMessage('Choose a model from the list, then save it explicitly.');}
    catch(e){onError(explainError((e as Error).message));}finally{setBusy(false);}}
  async function exportArchive(){setBusy(true);try{const archive=await api<unknown>('/v1/web/archive/export');const blob=new Blob([JSON.stringify(archive,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=`mural-web-${new Date().toISOString().slice(0,10)}.json`;anchor.click();URL.revokeObjectURL(url);setMessage('Web archive downloaded.');}
    catch(e){onError(explainError((e as Error).message));}finally{setBusy(false);}}
  async function importArchive(file?:File){if(!file)return;setBusy(true);try{const archive=JSON.parse(await file.text());if(importMode==='replace'&&!window.confirm('Replace all web conversations and saved words with this archive?'))return;
      const result=await api<{conversations:number;vocabulary:number}>('/v1/web/archive/import',{method:'POST',body:JSON.stringify({archive,mode:importMode})});await refresh();setMessage(`Restored ${result.conversations} conversations and ${result.vocabulary} words.`);}
    catch(e){onError((e as Error).message==='invalid_archive'?'That file is not a valid Mural web archive.':explainError((e as Error).message));}finally{setBusy(false);}}

  return <section className="content-page settings-page"><div className="page-title-row"><div><span className="eyebrow">MAKE IT YOURS</span><h1>Settings</h1><p>Your space, your choices.</p></div><span className="signed-in-email"><span className="account-dot"/>{email}</span></div>
    <div className="settings-columns"><div className="settings-column">
      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon">◌</span><div><h2>Learning</h2><p>Set the language and feel of your practice.</p></div></div>
        <div className="form-grid"><label>Language you’re learning<select value={prefs.languageID} onChange={e=>setPrefs({...prefs,languageID:e.target.value})}>{languages.map(item=><option value={item[0]} key={item[0]}>{item[1]} · {item[2]}</option>)}</select></label>
          <label>Meanings in<select value={prefs.meaningLanguage} onChange={e=>setPrefs({...prefs,meaningLanguage:e.target.value})}>{meaningLanguages.map(item=><option key={item}>{item}</option>)}</select></label>
          <label>Starting theme<select value={prefs.conversationTheme} onChange={e=>setPrefs({...prefs,conversationTheme:e.target.value})}>{themes.map(item=><option key={item[0]} value={item[0]}>{item[1]}</option>)}</select></label>
          <label>Appearance<select value={prefs.colorScheme} onChange={e=>setPrefs({...prefs,colorScheme:e.target.value as Preferences['colorScheme']})}><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
        <div className="settings-card-footer"><span>Changing language starts fresh. Previous conversations stay in Journal.</span><button className="button button-small" onClick={()=>void savePreferences()} disabled={busy||preferencesDisabled}>Save preferences</button></div>
      </section>

      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon">◉</span><div><h2>AI provider</h2><p>Choose exactly where text requests go. Credentials stay on your server.</p></div></div>
        <div className="provider-choice"><label className={`provider-option ${ai.provider==='siwc'?'chosen':''}`}><input type="radio" name="provider" checked={ai.provider==='siwc'} onChange={()=>setAI({...ai,provider:'siwc',apiStyle:'responses',nativeWebSearch:false})}/><span><strong>Sign in with ChatGPT</strong><small>Use your eligible ChatGPT plan for text.</small></span><b>Recommended</b></label>
          <label className={`provider-option ${ai.provider==='compatible'?'chosen':''}`}><input type="radio" name="provider" checked={ai.provider==='compatible'} onChange={()=>setAI({...ai,provider:'compatible'})}/><span><strong>OpenAI-compatible API</strong><small>Use any endpoint that supports Responses or Chat Completions.</small></span></label></div>
        {ai.provider==='siwc'?<><div className="connection-box"><div className={`connection-indicator ${ai.siwcConnected&&ai.siwcScopeGranted?'connected':''}`}/><div><strong>{ai.siwcConnected?ai.siwcEmail??'Connected account':'Not connected yet'}</strong>
          <p>{ai.siwcConnected&&ai.siwcScopeGranted?'ChatGPT plan access is enabled for Responses.': 'Complete a local SIWC sign-in, then transfer its protected credential file to this server over SSH.'}</p></div></div>
          <div className="provider-fields siwc-model"><label>ChatGPT model<input list="model-list" value={ai.model} onChange={e=>setAI({...ai,model:e.target.value})} placeholder="Choose a model" autoComplete="off"/><datalist id="model-list">{models.map(model=><option key={model} value={model}/>)}</datalist></label>
            <button className="text-button model-button" onClick={()=>void loadModels()} disabled={busy}>Load available models <span>↻</span></button></div>
          {!ai.secretsEncryptionConfigured&&<p className="provider-key-note">Set MURAL_SECRETS_ENCRYPTION_KEY on the server to encrypt the imported ChatGPT credentials.</p>}</>:
          <div className="provider-fields"><label>API base URL<input value={ai.apiBase} onChange={e=>setAI({...ai,apiBase:e.target.value})} placeholder="https://api.example.com/v1" autoComplete="url"/></label>
            <label>Model<input list="model-list" value={ai.model} onChange={e=>setAI({...ai,model:e.target.value})} placeholder="model-name" autoComplete="off"/><datalist id="model-list">{models.map(model=><option key={model} value={model}/>)}</datalist></label>
            <label>API format<select value={ai.apiStyle} onChange={e=>setAI({...ai,apiStyle:e.target.value as AISettings['apiStyle'],nativeWebSearch:false})}><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></select></label>
            <label>API key<input value={apiKey} onChange={e=>setApiKey(e.target.value)} type="password" placeholder={ai.hasCompatibleKey?'Saved securely · enter a new key to replace':'Paste a provider key'} autoComplete="new-password"/></label>
            <div className="provider-key-note">{ai.secretsEncryptionConfigured?'Encrypted on the server before it is stored.':'Set MURAL_SECRETS_ENCRYPTION_KEY on the server before saving keys.'}</div>
            {ai.hasCompatibleKey&&<label className="check-row"><input type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/>Remove the saved API key</label>}
            {ai.apiStyle==='responses'&&<label className="check-row"><input type="checkbox" checked={ai.nativeWebSearch} onChange={e=>setAI({...ai,nativeWebSearch:e.target.checked})}/>This provider supports the OpenAI web_search tool</label>}
            <button className="text-button model-button" onClick={()=>void loadModels()} disabled={busy}>Load model list <span>↻</span></button>
          </div>}
        <div className="settings-card-footer"><span>Only the selected provider receives text.</span><button className="button button-small" onClick={()=>void saveAI()} disabled={busy}>Save AI settings</button></div>
        {message&&<p className="inline-success" role="status">{message}</p>}
      </section>

      <section className="settings-card"><div className="settings-card-heading"><span className="settings-icon">♫</span><div><h2>Voice</h2><p>Live voice has its own monthly budget.</p></div></div>
        <div className="voice-budget-card"><div className="voice-budget-top"><span>GPT-Live</span><strong>$10 <small>/ UTC month</small></strong></div><div className="budget-track wide"><span style={{width:`${Math.min(100,(data.voice.usedMilliseconds+data.voice.reservedMilliseconds)/120_000)}%`}}/></div>
          <p>{data.voice.enabled?`${formatMinutes(data.voice.availableMilliseconds)} available to start a session · ${formatMinutes(data.voice.usedMilliseconds)} used`:'Voice is paused until OPENAI_API_KEY and hosted voice are configured on the server.'}</p>
          <small>Text practice works independently. The cap is enforced against reserved live-session time.</small></div>
      </section>
    </div>

    <aside className="settings-column side-settings">
      {ai.provider==='siwc'&&<section className="settings-card siwc-card"><span className="eyebrow">CHATGPT PLAN SETUP</span><h2>Connect from the server</h2><p>For this self-hosted app, the loopback sign-in happens on your laptop. Credentials are then transferred to the server through SSH and encrypted in its database.</p>
        <ol><li>Sign in to Mural once so your owner account exists.</li><li>On the host, run <code>docker compose run --rm api node dist/src/web-admin.js host-id</code>.</li><li>On your laptop, run <code>node scripts/siwc-login.mjs &lt;credential-file&gt; &lt;host-id&gt;</code>.</li><li>Copy that file to the host over SSH and run the <code>import-siwc</code> command from the web setup guide.</li></ol>
        <a className="text-button" href="/docs/web-app.md" target="_blank" rel="noreferrer">Read the SIWC transfer steps →</a>
      </section>}
      <section className="settings-card archive-card"><div className="settings-card-heading"><span className="settings-icon">▣</span><div><h2>Your archive</h2><p>Back up or restore this web history.</p></div></div>
        <div className="archive-controls"><button className="button button-secondary" onClick={()=>void exportArchive()} disabled={busy}>Download archive</button><label>Restore mode<select value={importMode} onChange={e=>setImportMode(e.target.value as 'merge'|'replace')}><option value="merge">Merge with current data</option><option value="replace">Replace current data</option></select></label>
          <label className="file-button">Choose archive<input type="file" accept="application/json,.json" onChange={e=>void importArchive(e.target.files?.[0])} disabled={busy}/></label></div>
        <small>Archives contain web conversations and saved words, never provider credentials.</small>
      </section>
      <section className="account-card"><div><span className="eyebrow">YOUR ACCOUNT</span><strong>{email}</strong><small>Private owner access</small></div><button className="button button-secondary" onClick={()=>void onSignOut()}>Sign out</button></section>
    </aside></div>
  </section>;
}
