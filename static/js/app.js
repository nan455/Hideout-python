'use strict';
/* Hideout Retro — Client v4 */

const S = {
  socket:null, nickname:'', avatar:'', mode:null,
  currentRoom:null, inPair:false, captchaId:null,
  typingTimer:null, activeView:'welcome',
  activeEmojiTarget:null, termsAccepted:false,
  soundOn:true, replyTo:null, activePoll:null,
  likedConfessions:new Set(), selectedMood:'😶',
  msgHistory:[], ctxTarget:null,
};

const $ = id => document.getElementById(id);
const Q = s => document.querySelector(s);
const QA = s => document.querySelectorAll(s);

// DOM
const termsModal     = $('terms-modal');
const termsCb        = $('terms-cb');
const termsAcceptBtn = $('terms-accept-btn');
const ageGate        = $('age-gate');
const captchaQ       = $('captcha-q');
const captchaAns     = $('captcha-ans');
const captchaErr     = $('captcha-err');
const enterBtn       = $('enter-btn');
const appEl          = $('app');
const sidebar        = $('sidebar');
const menuBtn        = $('menu-btn');
const myAvatar       = $('my-avatar');
const myNick         = $('my-nick');
const onlineCount    = $('online-count');
const tickerCount    = $('ticker-count');
const roomParam      = $('room-sub');
const roomInput      = $('room-input');
const roomJoinBtn    = $('room-join-btn');
const codedParam     = $('coded-sub');
const createRoomBtn  = $('create-room-btn');
const codeInput      = $('code-input');
const codeJoinBtn    = $('code-join-btn');
const codeError      = $('code-error');
const roomStatus     = $('room-status');
const rsName         = $('rs-name');
const rsCount        = $('rs-count');
const codeBadge      = $('code-badge');
const codeBadgeVal   = $('code-badge-val');
const copyCodeBtn    = $('copy-code-btn');
const tbRoom         = $('tb-room');
const tbUsers        = $('tb-users');
const pollBtn        = $('poll-btn');
const searchBtn      = $('search-btn');
const searchBar      = $('search-bar');
const searchInput    = $('search-input');
const searchClose    = $('search-close');
const pollModal      = $('poll-modal');
const pollQuestion   = $('poll-question');
const pollCancel     = $('poll-cancel');
const pollSubmit     = $('poll-submit');
const pollDisplay    = $('poll-display');
const messages       = $('messages');
const typingBar      = $('typing-bar');
const msgInput       = $('msg-input');
const charCount      = $('char-count');
const sendBtn        = $('send-btn');
const messages1v1    = $('messages-1v1');
const typingBar1v1   = $('typing-bar-1v1');
const msgInput1v1    = $('msg-input-1v1');
const sendBtn1v1     = $('send-btn-1v1');
const qStatus        = $('q-status');
const qPos           = $('q-pos');
const qTotal         = $('q-total');
const qTip           = $('q-tip');
const leaveQBtn      = $('leave-queue-btn');
const skipBtn        = $('skip-btn');
const leavePairBtn   = $('leave-pair-btn');
const pairLabel      = $('pair-label');
const emojiPicker    = $('emoji-picker');
const ctxMenu        = $('ctx-menu');
const ctxReply       = $('ctx-reply');
const ctxCopy        = $('ctx-copy');
const soundBtn       = $('sound-btn');
const themeBtn       = $('theme-btn');
const replyPreview   = $('reply-preview');
const replyText      = $('reply-text');
const cancelReply    = $('cancel-reply');
const confessInput   = $('confess-input');
const postConfessBtn = $('post-confess-btn');
const confessFeed    = $('confess-feed');
const interestSearch = $('interest-search');

const views = { welcome:$('view-welcome'), chat:$('view-chat'), queue:$('view-queue'), '1v1':$('view-1v1') };

// ── Stars bg ──────────────────────────────────────────────────
(function makeStars(){
  const c=$('stars-bg'); if(!c) return;
  for(let i=0;i<80;i++){
    const s=document.createElement('div'); s.className='star';
    const sz=Math.random()*3+1;
    s.style.cssText=`width:${sz}px;height:${sz}px;left:${Math.random()*100}%;top:${Math.random()*100}%;--d:${1.5+Math.random()*3}s;--dl:${Math.random()*3}s`;
    c.appendChild(s);
  }
})();

// ── Sound ─────────────────────────────────────────────────────
let audioCtx=null;
function playSound(type='msg'){
  if(!S.soundOn) return;
  try{
    if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    const o=audioCtx.createOscillator(), g=audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    const now=audioCtx.currentTime;
    if(type==='msg'){ o.frequency.setValueAtTime(660,now); o.frequency.exponentialRampToValueAtTime(880,now+.06); g.gain.setValueAtTime(.06,now); g.gain.exponentialRampToValueAtTime(.001,now+.18); }
    else if(type==='match'){ [523,659,784].forEach((f,i)=>o.frequency.setValueAtTime(f,now+i*.1)); g.gain.setValueAtTime(.08,now); g.gain.exponentialRampToValueAtTime(.001,now+.45); }
    else if(type==='join'){ o.frequency.setValueAtTime(440,now); o.frequency.exponentialRampToValueAtTime(550,now+.1); g.gain.setValueAtTime(.05,now); g.gain.exponentialRampToValueAtTime(.001,now+.2); }
    o.start(); o.stop(now+.5);
  }catch(e){}
}

soundBtn.addEventListener('click',()=>{ S.soundOn=!S.soundOn; soundBtn.textContent=S.soundOn?'🔔':'🔕'; toast(S.soundOn?'Sound on 🔔':'Sound off 🔕','info',1200); });
themeBtn.addEventListener('click',()=>{
  const lt=document.documentElement.getAttribute('data-theme')==='light';
  document.documentElement.setAttribute('data-theme',lt?'':'light');
  themeBtn.textContent=lt?'🎨':'🌙';
  toast(lt?'Dark mode 🌙':'Light mode ☀️','info',1200);
});

// ── Utils ──────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function fmtAgo(ts){ const s=Math.floor((Date.now()-ts)/1000); if(s<60) return 'just now'; if(s<3600) return `${Math.floor(s/60)}m ago`; return `${Math.floor(s/3600)}h ago`; }

function toast(msg,type='info',dur=3000){
  const tc=$('toasts'),el=document.createElement('div');
  el.className=`toast ${type}`;
  el.innerHTML=`<span>${{info:'💬',warn:'⚠️',error:'❌',success:'✅'}[type]||'📻'}</span><span>${esc(msg)}</span>`;
  tc.appendChild(el);
  setTimeout(()=>{ el.style.cssText='transition:.22s;opacity:0;transform:translateX(12px)'; setTimeout(()=>el.remove(),230); },dur);
}

function showView(name){
  Object.entries(views).forEach(([k,v])=>{ v.classList.toggle('active',k===name); v.classList.toggle('hidden',k!==name); });
  S.activeView=name;
}

function clickMode(m){ document.querySelector(`[data-mode="${m}"]`)?.click(); }
window.clickMode=clickMode;
function switchPanel(id){ document.querySelector(`[data-panel="${id}"]`)?.click(); }
window.switchPanel=switchPanel;

// ── Panel tabs ─────────────────────────────────────────────────
QA('.nav-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    QA('.nav-tab').forEach(t=>t.classList.remove('active'));
    QA('.sb-panel').forEach(p=>{ p.classList.remove('active'); p.classList.add('hidden'); });
    tab.classList.add('active');
    const panel=$(tab.dataset.panel);
    if(panel){ panel.classList.remove('hidden'); panel.classList.add('active'); }
    if(tab.dataset.panel==='confess-panel') loadConfessions();
  });
});

// ── Terms ──────────────────────────────────────────────────────
termsCb.addEventListener('change',()=>{ termsAcceptBtn.disabled=!termsCb.checked; });
termsAcceptBtn.addEventListener('click',()=>{
  if(!termsCb.checked) return;
  S.termsAccepted=true; termsModal.classList.add('hidden');
  ageGate.classList.remove('hidden'); loadCaptcha();
});

// ── Captcha ────────────────────────────────────────────────────
async function loadCaptcha(){
  captchaQ.textContent='…';
  try{ const d=await fetch('/generate-captcha').then(r=>r.json()); S.captchaId=d.id; captchaQ.textContent=`${d.question} = ?`; captchaAns.value=''; captchaErr.textContent=''; }
  catch{ captchaQ.textContent='Error. Refresh.'; }
}
enterBtn.addEventListener('click',async()=>{
  const ans=captchaAns.value.trim(); if(!ans){ captchaErr.textContent='Enter the answer!'; return; }
  enterBtn.disabled=true; enterBtn.textContent='Checking…';
  try{
    const d=await fetch('/verify-captcha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captchaId:S.captchaId,answer:ans,termsAccepted:S.termsAccepted})}).then(r=>r.json());
    if(d.success){ ageGate.classList.add('hidden'); appEl.classList.remove('hidden'); initSocket(); }
    else{ captchaErr.textContent=d.message||'Wrong!'; loadCaptcha(); }
  }catch{ captchaErr.textContent='Network error 😢'; }
  enterBtn.disabled=false; enterBtn.textContent='Enter Hideout 🚀';
});
captchaAns.addEventListener('keydown',e=>{ if(e.key==='Enter') enterBtn.click(); });

// ── Socket ─────────────────────────────────────────────────────
function initSocket(){
  S.socket=io({transports:['polling','websocket'],reconnection:true,reconnectionDelay:1000,reconnectionAttempts:25,timeout:20000});
  const sk=S.socket;

  sk.on('connect',()=>{ $('tb-room').style.opacity='1'; sk.emit('getOnlineCount'); });
  sk.on('disconnect',()=>toast('Connection lost. Reconnecting…','warn'));

  sk.on('welcome',({nickname,avatar,online})=>{
    S.nickname=nickname; S.avatar=avatar;
    myAvatar.textContent=avatar; myNick.textContent=nickname;
    onlineCount.textContent=online||0; if(tickerCount) tickerCount.textContent=online||0;
    showView('welcome');
  });

  sk.on('onlineCount',({count})=>{
    onlineCount.textContent=count;
    if(tickerCount) tickerCount.textContent=count;
  });

  sk.on('joinedRoom',({room,userCount,code,isOwner,poll})=>{
    S.currentRoom=room; S.msgHistory=[]; S.activePoll=poll||null;
    const label=room.replace(/^(room_|interest_|global_|coded_)/,'')||room;
    rsName.textContent=code?`🔐 ${code}`:`# ${label}`;
    rsCount.textContent=userCount; roomStatus.classList.remove('hidden');
    tbRoom.textContent=code?`🔐 ${code}`:`📻 ${label}`;
    tbUsers.textContent=`${userCount} chatting`; tbUsers.classList.remove('hidden');
    if(code){ codeBadgeVal.textContent=code; codeBadge.classList.remove('hidden'); }
    else codeBadge.classList.add('hidden');
    pollBtn.style.display='flex';
    renderPoll(poll);
    showView('chat'); clearMsgs(messages); msgInput.focus(); playSound('join');
  });

  sk.on('roomUpdate',({userCount})=>{ rsCount.textContent=userCount; tbUsers.textContent=`${userCount} chatting`; });

  sk.on('chat message',({nickname,avatar,msg,timestamp,type,msgId,replyTo})=>{
    const box=S.activeView==='1v1'?messages1v1:messages;
    if(type==='system') appendSys(box,msg);
    else{
      appendMsg(box,nickname,avatar,msg,timestamp,nickname===S.nickname,msgId,replyTo);
      S.msgHistory.push({nickname,msg,timestamp,msgId});
      if(S.msgHistory.length>500) S.msgHistory.shift();
      if(nickname!==S.nickname) playSound('msg');
    }
  });

  sk.on('reaction',({emoji,from})=>spawnFloat(emoji,from));

  sk.on('typing',name=>{
    const bar=S.activeView==='1v1'?typingBar1v1:typingBar;
    bar.innerHTML=`<div class="type-dots"><span></span><span></span><span></span></div><span>${esc(name)} is typing…</span>`;
    bar.classList.remove('hidden');
  });
  sk.on('stopTyping',()=>{ typingBar.classList.add('hidden'); typingBar1v1.classList.add('hidden'); });

  sk.on('queueStatus',({position,total,message})=>{
    qPos.textContent=position; qTotal.textContent=total>1?`/ ${total}`:''; qStatus.textContent=message||'Searching…';
  });
  sk.on('matched',({partnerName,partnerAvatar,roomId})=>{
    S.currentRoom=roomId; S.inPair=true; S.msgHistory=[];
    clearMsgs(messages1v1);
    appendSys(messages1v1,`${partnerAvatar} You're now chatting with ${partnerName}!`);
    tbRoom.textContent=`${partnerAvatar} ${partnerName}`;
    pairLabel.textContent=`chatting with ${partnerAvatar} ${partnerName}`;
    showView('1v1'); playSound('match');
    toast(`Matched with ${partnerAvatar} ${partnerName}! 🎉`,'success');
    msgInput1v1.focus();
  });
  sk.on('partnerLeft',({message})=>{
    appendSys(messages1v1,message); toast(message,'warn');
    S.inPair=false; S.currentRoom=null;
    setTimeout(()=>{ showView('queue'); sk.emit('join1v1'); },2000);
  });
  sk.on('leftQueue',()=>{
    S.inPair=false; S.currentRoom=null; showView('welcome');
    tbRoom.textContent='📻 Hideout'; tbUsers.classList.add('hidden');
    roomStatus.classList.add('hidden'); codeBadge.classList.add('hidden');
    pollBtn.style.display='none'; pollDisplay.classList.add('hidden');
  });

  sk.on('codeError',({message})=>{ codeError.textContent=message; toast(message,'error'); });
  sk.on('notice',({type,msg})=>toast(msg,type));
  sk.on('error',({msg})=>toast(msg,'error'));

  // Poll events
  sk.on('pollCreated',poll=>{ S.activePoll=poll; renderPoll(poll); });
  sk.on('pollUpdated',poll=>{ S.activePoll=poll; renderPoll(poll); });

  // Confession events
  sk.on('newConfession',entry=>{ prependConfession(entry); });
  sk.on('confessionLiked',({id,likes})=>{
    const el=document.querySelector(`.confess-item[data-id="${id}"] .like-count`);
    if(el) el.textContent=likes;
  });
}

// ── Mode buttons ───────────────────────────────────────────────
QA('.mode-card').forEach(btn=>{
  btn.addEventListener('click',()=>{
    QA('.mode-card').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    S.mode=btn.dataset.mode;
    roomParam.classList.add('hidden'); codedParam.classList.add('hidden'); codeError.textContent='';
    if(S.mode==='room')  { roomParam.classList.remove('hidden'); roomInput.focus(); }
    if(S.mode==='coded') { codedParam.classList.remove('hidden'); }
    if(S.mode==='random'){ doJoin('random'); closeSB(); }
    if(S.mode==='1v1')   { doJoin1v1(); closeSB(); }
  });
});

roomJoinBtn.addEventListener('click',()=>{ const v=roomInput.value.trim(); if(v){doJoin('room',v);closeSB();}else roomInput.focus(); });
roomInput.addEventListener('keydown',e=>{ if(e.key==='Enter') roomJoinBtn.click(); });

// Interest tags
QA('.interest-tag').forEach(tag=>{
  tag.addEventListener('click',()=>{
    QA('.interest-tag').forEach(t=>t.classList.remove('sel'));
    tag.classList.add('sel');
    doJoin('interest',tag.dataset.tag);
    // Switch to chat panel
    Q('[data-panel="chat-panel"]')?.click();
    closeSB();
    toast(`Joining #${tag.dataset.tag} 🎯`,'info',1500);
  });
});

// Interest search filter
interestSearch?.addEventListener('input',()=>{
  const q=interestSearch.value.toLowerCase();
  QA('.interest-tag').forEach(t=>{
    t.style.display=(!q||t.dataset.tag.includes(q))?'':'none';
  });
  QA('.cat-group').forEach(g=>{
    const visible=[...g.querySelectorAll('.interest-tag')].some(t=>t.style.display!=='none');
    g.style.display=visible?'':'none';
  });
});

createRoomBtn.addEventListener('click',()=>{ if(!S.socket){toast('Not connected','warn');return;} S.socket.emit('createCodedRoom'); closeSB(); });
codeJoinBtn.addEventListener('click',()=>{
  const code=codeInput.value.trim();
  if(!code){codeError.textContent='Enter a code!';return;}
  if(!/^\d{5}$/.test(code)){codeError.textContent='Must be 5 digits!';return;}
  codeError.textContent='';
  if(!S.socket){toast('Not connected','warn');return;}
  S.socket.emit('joinByCode',{code}); closeSB();
});
codeInput.addEventListener('keydown',e=>{ if(e.key==='Enter') codeJoinBtn.click(); });
copyCodeBtn.addEventListener('click',()=>{
  const code=codeBadgeVal.textContent;
  if(code&&code!=='—') navigator.clipboard.writeText(code).then(()=>toast(`Code ${code} copied! 📋`,'success')).catch(()=>toast('Code: '+code,'info',6000));
});

function doJoin(mode,param=''){
  if(!S.socket){toast('Not connected yet!','warn');return;}
  clearReplyTo(); S.socket.emit('joinMode',{mode,param}); tbRoom.textContent='📻 Joining…';
}
function doJoin1v1(){
  if(!S.socket){toast('Not connected yet!','warn');return;}
  clearReplyTo(); clearMsgs(messages1v1); showView('queue');
  tbRoom.textContent='🎲 Finding a match…'; tbUsers.classList.add('hidden');
  roomStatus.classList.add('hidden'); pollBtn.style.display='none';
  S.socket.emit('join1v1');
}

// ── Tips ───────────────────────────────────────────────────────
const TIPS=['Start with "would you rather…"?','Ask their unpopular opinion 🔥','What\'s your most random skill?','Best meme of the week?','Tell me something that made you smile today 😊','What would you do with a million dollars?','Rate your day 1-10 and explain 📊','What\'s something you secretly love?'];
let tipIdx=0;
setInterval(()=>{ if(qTip) qTip.textContent=TIPS[tipIdx=(tipIdx+1)%TIPS.length]; },5000);
if(qTip) qTip.textContent=TIPS[0];

leaveQBtn.addEventListener('click',()=>{ S.socket&&S.socket.emit('leave1v1'); });
skipBtn.addEventListener('click',()=>{ if(S.socket){S.socket.emit('skip1v1');clearMsgs(messages1v1);clearReplyTo();} });
leavePairBtn.addEventListener('click',()=>{ S.socket&&S.socket.emit('leave1v1'); clearReplyTo(); });

// ── Messaging ──────────────────────────────────────────────────
function sendMsg(input){
  const msg=input.value.trim(); if(!msg||!S.socket) return;
  const payload={msg}; if(S.replyTo) payload.replyTo=S.replyTo;
  S.socket.emit('chat message',payload); input.value='';
  if(input===msgInput) updateChars('');
  clearTimeout(S.typingTimer); S.socket.emit('stopTyping'); clearReplyTo(); input.focus();
}
sendBtn.addEventListener('click',()=>sendMsg(msgInput));
sendBtn1v1.addEventListener('click',()=>sendMsg(msgInput1v1));
[msgInput,msgInput1v1].forEach(inp=>inp.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg(inp);} }));

function updateChars(val){
  const l=500-val.length; charCount.textContent=l;
  charCount.className='char-badge'+(l<100?' warn':'')+(l<30?' danger':'');
}
msgInput.addEventListener('input',()=>{
  updateChars(msgInput.value);
  if(!S.socket) return;
  S.socket.emit('typing'); clearTimeout(S.typingTimer);
  S.typingTimer=setTimeout(()=>S.socket&&S.socket.emit('stopTyping'),1500);
});
msgInput1v1.addEventListener('input',()=>{
  if(!S.socket) return;
  S.socket.emit('typing'); clearTimeout(S.typingTimer);
  S.typingTimer=setTimeout(()=>S.socket&&S.socket.emit('stopTyping'),1500);
});

// ── Search ─────────────────────────────────────────────────────
searchBtn.addEventListener('click',()=>{
  searchBar.classList.toggle('hidden');
  if(!searchBar.classList.contains('hidden')){ searchInput.focus(); searchInput.value=''; }
  else clearSearch();
});
searchClose.addEventListener('click',()=>{ searchBar.classList.add('hidden'); clearSearch(); });
searchInput.addEventListener('input',()=>{
  const q=searchInput.value.trim().toLowerCase();
  if(!q){clearSearch();return;}
  const box=S.activeView==='1v1'?messages1v1:messages;
  let found=0;
  box.querySelectorAll('.msg-row:not(.sys)').forEach(row=>{
    const txt=(row.querySelector('.msg-bubble')?.textContent||'').toLowerCase();
    const m=txt.includes(q); row.classList.toggle('highlighted',m); row.style.opacity=m?'1':'0.25';
    if(m&&!found++){row.scrollIntoView({behavior:'smooth',block:'center'});}
  });
  if(q&&!found) toast('No messages found','info',1500);
});
function clearSearch(){
  const box=S.activeView==='1v1'?messages1v1:messages;
  box.querySelectorAll('.msg-row').forEach(r=>{r.classList.remove('highlighted');r.style.opacity='';});
}

// ── Reactions ─────────────────────────────────────────────────
QA('.react').forEach(btn=>{
  btn.addEventListener('click',()=>{ if(S.socket&&S.currentRoom) S.socket.emit('reaction',{emoji:btn.dataset.emoji}); });
});

function spawnFloat(emoji,from){
  const el=document.createElement('div'); el.className='float-r';
  el.textContent=emoji; el.style.left=(15+Math.random()*170)+'px';
  $('floats').appendChild(el); setTimeout(()=>el.remove(),1700);
  const tc=$('toasts'),t=document.createElement('div');
  t.className='toast info'; t.style.cssText='padding:.28rem .6rem;font-size:.72rem';
  t.innerHTML=`<span>${emoji}</span><span style="color:var(--txt3)">${esc(from)}</span>`;
  tc.appendChild(t); setTimeout(()=>{t.style.cssText+=';transition:.2s;opacity:0';setTimeout(()=>t.remove(),210);},1300);
}

// ── Reply-to ───────────────────────────────────────────────────
function setReplyTo(nick,msg){
  S.replyTo={nick,msg};
  replyText.textContent=`↩ ${nick}: ${msg.substring(0,50)}${msg.length>50?'…':''}`;
  replyPreview.classList.remove('hidden');
  (S.activeView==='1v1'?msgInput1v1:msgInput).focus();
}
function clearReplyTo(){
  S.replyTo=null; replyPreview.classList.add('hidden');
}
cancelReply.addEventListener('click',clearReplyTo);
window.clearReplyTo=clearReplyTo;

// Context menu
document.addEventListener('click',()=>ctxMenu.classList.add('hidden'));
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ctxMenu.classList.add('hidden');pollModal.classList.add('hidden');} });

ctxReply.addEventListener('click',()=>{ if(S.ctxTarget) setReplyTo(S.ctxTarget.nick,S.ctxTarget.msg); ctxMenu.classList.add('hidden'); });
ctxCopy.addEventListener('click',()=>{ if(S.ctxTarget) navigator.clipboard.writeText(S.ctxTarget.msg).then(()=>toast('Copied! 📋','success',1200)); ctxMenu.classList.add('hidden'); });

// ── Poll feature ───────────────────────────────────────────────
pollBtn.addEventListener('click',()=>{ pollModal.classList.toggle('hidden'); pollQuestion.focus(); });
pollCancel.addEventListener('click',()=>pollModal.classList.add('hidden'));
pollSubmit.addEventListener('click',()=>{
  if(!S.socket||!S.currentRoom){toast('Join a room first!','warn');return;}
  const q=pollQuestion.value.trim();
  const opts=[$('poll-opt1'),$('poll-opt2'),$('poll-opt3'),$('poll-opt4')].map(i=>i.value.trim()).filter(Boolean);
  if(!q){toast('Enter a question!','warn');return;}
  if(opts.length<2){toast('Need at least 2 options!','warn');return;}
  S.socket.emit('createPoll',{question:q,options:opts});
  pollModal.classList.add('hidden');
  ['poll-question','poll-opt1','poll-opt2','poll-opt3','poll-opt4'].forEach(id=>$(id).value='');
});

function renderPoll(poll){
  if(!poll){ pollDisplay.classList.add('hidden'); return; }
  const total=poll.options.reduce((s,o)=>s+o.votes,0);
  const hasVoted=poll.options.some(o=>o.voters&&o.voters.includes(S.socket?.id));
  pollDisplay.innerHTML=`
    <div class="poll-q">📊 ${esc(poll.question)}</div>
    <div class="poll-options">
      ${poll.options.map((o,i)=>{
        const pct=total>0?Math.round(o.votes/total*100):0;
        return `<div class="poll-opt${hasVoted?' voted':''}" data-idx="${i}">
          <div class="poll-bar" style="width:${pct}%"></div>
          <span class="poll-opt-text">${esc(o.text)}</span>
          ${hasVoted?`<span class="poll-pct">${pct}%</span>`:''}
        </div>`;
      }).join('')}
    </div>
    <div class="poll-creator">by ${esc(poll.creator)} · ${total} vote${total!==1?'s':''}</div>`;
  pollDisplay.classList.remove('hidden');
  if(!hasVoted){
    pollDisplay.querySelectorAll('.poll-opt').forEach(opt=>{
      opt.addEventListener('click',()=>{ S.socket?.emit('votePoll',{optionIndex:parseInt(opt.dataset.idx)}); });
    });
  }
}

// ── Confession board ───────────────────────────────────────────
QA('.mood-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    QA('.mood-btn').forEach(b=>b.classList.remove('selected'));
    btn.classList.add('selected'); S.selectedMood=btn.dataset.mood;
  });
});

postConfessBtn.addEventListener('click',()=>{
  const msg=confessInput.value.trim();
  if(!msg){toast('Write something first!','warn');return;}
  if(!S.socket){toast('Not connected','warn');return;}
  S.socket.emit('postConfession',{msg,mood:S.selectedMood});
  confessInput.value='';
});

async function loadConfessions(){
  try{
    const data=await fetch('/confessions').then(r=>r.json());
    confessFeed.innerHTML='';
    if(!data.length){ confessFeed.innerHTML='<p class="feed-empty">No confessions yet… be the first! 🤫</p>'; return; }
    data.forEach(c=>prependConfession(c,true));
  }catch{ confessFeed.innerHTML='<p class="feed-empty">Could not load 😢</p>'; }
}

function prependConfession(c,append=false){
  const el=document.createElement('div');
  el.className='confess-item'; el.dataset.id=c.id;
  const liked=S.likedConfessions.has(c.id);
  el.innerHTML=`
    <div class="ci-top">
      <span class="ci-mood">${c.mood||'😶'}</span>
      <span class="ci-time">${fmtAgo(c.ts)}</span>
    </div>
    <div class="ci-msg">${esc(c.msg)}</div>
    <div class="ci-actions">
      <button class="like-btn${liked?' liked':''}" data-id="${c.id}">
        ❤️ <span class="like-count">${c.likes||0}</span>
      </button>
    </div>`;
  el.querySelector('.like-btn').addEventListener('click',function(){
    if(S.likedConfessions.has(c.id)) return;
    S.socket?.emit('likeConfession',{id:c.id});
    S.likedConfessions.add(c.id); this.classList.add('liked');
  });
  if(append) confessFeed.appendChild(el);
  else{
    const empty=confessFeed.querySelector('.feed-empty');
    if(empty) empty.remove();
    confessFeed.insertBefore(el,confessFeed.firstChild);
  }
}

// ── Emoji picker ───────────────────────────────────────────────
QA('.emoji-toggle').forEach(btn=>{
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const ti=$(btn.dataset.target);
    const r=btn.getBoundingClientRect();
    emojiPicker.style.cssText=`position:fixed;bottom:${window.innerHeight-r.top+8}px;left:${Math.min(r.left,window.innerWidth-232)}px;right:auto`;
    S.activeEmojiTarget=ti; emojiPicker.classList.toggle('hidden');
  });
});
emojiPicker.querySelectorAll('span').forEach(s=>{
  s.addEventListener('click',()=>{ if(S.activeEmojiTarget){S.activeEmojiTarget.value+=s.textContent;S.activeEmojiTarget.focus();} });
});
document.addEventListener('click',e=>{ if(!emojiPicker.contains(e.target)&&!e.target.classList.contains('emoji-toggle')) emojiPicker.classList.add('hidden'); });

// ── Message render ─────────────────────────────────────────────
function appendMsg(box,nick,avatar,msg,ts,isMine,msgId,replyTo){
  const row=document.createElement('div');
  row.className=`msg-row${isMine?' mine':''}`;
  if(msgId) row.dataset.msgId=msgId;
  const rq=replyTo?`<div class="reply-quote-bubble">↩ ${esc(replyTo.nick)}: ${esc((replyTo.msg||'').substring(0,40))}</div>`:'';
  row.innerHTML=`<div class="msg-ava">${esc(avatar||'📻')}</div>
    <div class="msg-body">
      ${!isMine?`<span class="msg-nick">${esc(nick)}</span>`:''}
      ${rq}
      <div class="msg-bubble">${esc(msg)}</div>
      <span class="msg-time">${fmtTime(ts)}</span>
    </div>`;
  const bubble=row.querySelector('.msg-bubble');
  bubble.addEventListener('contextmenu',e=>{
    e.preventDefault(); S.ctxTarget={nick,msg,bubble};
    ctxMenu.style.cssText=`left:${Math.min(e.clientX,window.innerWidth-145)}px;top:${Math.min(e.clientY,window.innerHeight-85)}px`;
    ctxMenu.classList.remove('hidden');
  });
  let lpt;
  bubble.addEventListener('touchstart',()=>{ lpt=setTimeout(()=>{ S.ctxTarget={nick,msg,bubble}; ctxMenu.style.cssText=`left:50%;top:40%;transform:translate(-50%)`;ctxMenu.classList.remove('hidden'); },600); });
  bubble.addEventListener('touchend',()=>clearTimeout(lpt));
  box.appendChild(row); box.scrollTop=box.scrollHeight;
}

function appendSys(box,msg){
  const row=document.createElement('div'); row.className='msg-row sys';
  row.innerHTML=`<div class="msg-bubble">${esc(msg)}</div>`;
  box.appendChild(row); box.scrollTop=box.scrollHeight;
}
function clearMsgs(box){ box.innerHTML=''; }

// ── Sidebar mobile ─────────────────────────────────────────────
menuBtn.addEventListener('click',()=>sidebar.classList.toggle('open'));
function closeSB(){ sidebar.classList.remove('open'); }
document.addEventListener('click',e=>{ if(!sidebar.contains(e.target)&&e.target!==menuBtn) closeSB(); });