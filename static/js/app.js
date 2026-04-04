'use strict';
/* Hideout Pro — Client */

const S = {
  socket:null, nickname:'', avatar:'', mode:null,
  currentRoom:null, inPair:false, captchaId:null,
  typingTimer:null, activeView:'welcome', activeEmojiTarget:null,
  termsAccepted:false,
};

const $ = id => document.getElementById(id);
const Q = sel => document.querySelector(sel);

// DOM
const termsModal    = $('terms-modal');
const termsCb       = $('terms-cb');
const termsAcceptBtn= $('terms-accept-btn');
const ageGate       = $('age-gate');
const captchaQ      = $('captcha-q');
const captchaAns    = $('captcha-ans');
const captchaErr    = $('captcha-err');
const enterBtn      = $('enter-btn');
const appEl         = $('app');
const sidebar       = $('sidebar');
const sbToggle      = $('sidebar-toggle');
const myAvatar      = $('my-avatar');
const myNick        = $('my-nick');
const onlineCount   = $('online-count');
const modeBtns      = document.querySelectorAll('.mode-btn');
const roomParam     = $('room-param');
const roomInput     = $('room-input');
const roomJoinBtn   = $('room-join-btn');
const interestP     = $('interest-param');
const tagBtns       = document.querySelectorAll('.tag-btn');
const codedParam    = $('coded-param');
const createRoomBtn = $('create-room-btn');
const codeInput     = $('code-input');
const codeJoinBtn   = $('code-join-btn');
const codeError     = $('code-error');
const roomInfoBox   = $('room-info-box');
const ribName       = $('rib-name');
const ribCount      = $('rib-count');
const roomCodeBadge = $('room-code-badge');
const roomCodeDisp  = $('room-code-display');
const copyCodeBtn   = $('copy-code-btn');
const tbTitle       = $('tb-title');
const tbStatus      = $('tb-status');
const messages      = $('messages');
const typingBar     = $('typing-bar');
const chatForm      = $('chat-form');
const msgInput      = $('msg-input');
const charCount     = $('char-count');
const messages1v1   = $('messages-1v1');
const typingBar1v1  = $('typing-bar-1v1');
const chatForm1v1   = $('chat-form-1v1');
const msgInput1v1   = $('msg-input-1v1');
const qStatus       = $('q-status');
const qPos          = $('q-pos');
const qTotal        = $('q-total');
const qTip          = $('q-tip');
const leaveQBtn     = $('leave-queue-btn');
const skipBtn       = $('skip-btn');
const leavePairBtn  = $('leave-pair-btn');
const emojiPicker   = $('emoji-picker');
const floatReact    = $('float-reactions');

const views = {
  welcome:$('view-welcome'), chat:$('view-chat'),
  queue  :$('view-queue'),   '1v1':$('view-1v1'),
};

// ── Utils ──────────────────────────────────────────────────────
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

function toast(msg,type='info',dur=3500){
  const tc=$('toast-container'), el=document.createElement('div');
  el.className=`toast ${type}`;
  el.innerHTML=`<span>${{info:'💬',warn:'⚠️',error:'❌',success:'✅'}[type]||'ℹ️'}</span><span>${esc(msg)}</span>`;
  tc.appendChild(el);
  setTimeout(()=>{ el.style.cssText='transition:.3s;opacity:0;transform:translateX(18px)'; setTimeout(()=>el.remove(),310); }, dur);
}

function showView(name){
  Object.entries(views).forEach(([k,v])=>{ v.classList.toggle('active',k===name); v.classList.toggle('hidden',k!==name); });
  S.activeView=name;
}

// Rotating tips for the queue screen
const TIPS = [
  "Be yourself — you're anonymous anyway 😎",
  "Start with a fun question to break the ice!",
  "Respect goes both ways. Be kind 🙏",
  "Share a meme, a joke, or a hot take.",
  "Your chat history is deleted when you leave.",
  "You can skip and find a new partner anytime.",
  "Global chat is great for meeting many people at once.",
  "Use interest rooms to find people like you 🎯",
];
let tipIdx=0;
setInterval(()=>{ if(qTip) qTip.textContent=TIPS[tipIdx=(tipIdx+1)%TIPS.length]; }, 5000);
if(qTip) qTip.textContent=TIPS[0];

// ── Terms & Conditions ─────────────────────────────────────────
termsCb.addEventListener('change',()=>{
  termsAcceptBtn.disabled = !termsCb.checked;
});

termsAcceptBtn.addEventListener('click',()=>{
  if(!termsCb.checked) return;
  S.termsAccepted=true;
  termsModal.classList.add('hidden');
  ageGate.classList.remove('hidden');
  loadCaptcha();
});

// ── Captcha ────────────────────────────────────────────────────
async function loadCaptcha(){
  captchaQ.textContent='…';
  try{
    const d=await fetch('/generate-captcha').then(r=>r.json());
    S.captchaId=d.id; captchaQ.textContent=`${d.question} = ?`;
    captchaAns.value=''; captchaErr.textContent='';
  }catch{ captchaQ.textContent='Error. Refresh.'; }
}

enterBtn.addEventListener('click',async()=>{
  const ans=captchaAns.value.trim();
  if(!ans){ captchaErr.textContent='Enter the answer.'; return; }
  enterBtn.disabled=true; enterBtn.textContent='Verifying…';
  try{
    const d=await fetch('/verify-captcha',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({captchaId:S.captchaId, answer:ans, termsAccepted:S.termsAccepted})
    }).then(r=>r.json());
    if(d.success){
      ageGate.classList.add('hidden');
      appEl.classList.remove('hidden');
      initSocket();
    } else { captchaErr.textContent=d.message||'Wrong answer.'; loadCaptcha(); }
  }catch{ captchaErr.textContent='Network error.'; }
  enterBtn.disabled=false; enterBtn.textContent='Enter Hideout →';
});
captchaAns.addEventListener('keydown',e=>{ if(e.key==='Enter') enterBtn.click(); });

// ── Socket ─────────────────────────────────────────────────────
function initSocket(){
  S.socket = io({
    transports:['polling','websocket'],  // polling first for Render proxy!
    reconnection:true, reconnectionDelay:1000, reconnectionAttempts:25, timeout:20000,
  });
  const sk=S.socket;

  sk.on('connect',()=>{
    tbStatus.textContent='● Connected'; tbStatus.className='tb-status connected'; tbStatus.classList.remove('hidden');
    sk.emit('getOnlineCount');
  });
  sk.on('connect_error',()=>{
    tbStatus.textContent='● Connecting…'; tbStatus.className='tb-status disconnected'; tbStatus.classList.remove('hidden');
  });
  sk.on('disconnect',()=>{
    tbStatus.textContent='● Reconnecting…'; tbStatus.className='tb-status disconnected';
    toast('Connection lost. Reconnecting…','warn');
  });

  sk.on('welcome',({nickname,avatar,online})=>{
    S.nickname=nickname; S.avatar=avatar;
    myAvatar.textContent=avatar; myNick.textContent=nickname;
    onlineCount.textContent=online||0;
    showView('welcome');
  });
  sk.on('onlineCount',({count})=>{ onlineCount.textContent=count; });

  sk.on('joinedRoom',({room,userCount,code,isOwner})=>{
    S.currentRoom=room;
    const label=room.replace(/^(room_|interest_|global_|coded_)/,'')||room;
    ribName.textContent=code?`#${code}`:`#${label}`;
    ribCount.textContent=userCount;
    roomInfoBox.classList.remove('hidden');
    if(code){
      roomCodeDisp.textContent=code;
      roomCodeBadge.classList.remove('hidden');
      tbTitle.textContent=`🔐 Private · ${code}`;
    } else {
      roomCodeBadge.classList.add('hidden');
      tbTitle.textContent=`# ${label}`;
    }
    showView('chat'); clearMsgs(messages); msgInput.focus();
  });

  sk.on('roomUpdate',({userCount})=>{ ribCount.textContent=userCount; });

  sk.on('chat message',({nickname,avatar,msg,timestamp,type,msgId})=>{
    const box=S.activeView==='1v1'?messages1v1:messages;
    if(type==='system') appendSys(box,msg);
    else appendMsg(box,nickname,avatar,msg,timestamp,nickname===S.nickname,msgId);
  });

  sk.on('reaction',({emoji,from})=>{ spawnFloatReaction(emoji,from); });

  sk.on('typing',name=>{
    const bar=S.activeView==='1v1'?typingBar1v1:typingBar;
    bar.innerHTML=`<span class="typing-dots"></span> ${esc(name)} is typing`;
    bar.classList.remove('hidden');
  });
  sk.on('stopTyping',()=>{ typingBar.classList.add('hidden'); typingBar1v1.classList.add('hidden'); });

  sk.on('queueStatus',({position,total,message})=>{
    qPos.textContent=position; qTotal.textContent=total>1?`of ${total}`:'';
    qStatus.textContent=message||'Searching…';
  });

  sk.on('matched',({partnerName,partnerAvatar,roomId})=>{
    S.currentRoom=roomId; S.inPair=true;
    clearMsgs(messages1v1);
    appendSys(messages1v1,`${partnerAvatar} Matched with ${partnerName}! Say hi 👋`);
    tbTitle.textContent=`💬 ${partnerAvatar} ${partnerName}`;
    showView('1v1'); toast(`Matched with ${partnerAvatar} ${partnerName}!`,'success');
    msgInput1v1.focus();
  });
  sk.on('partnerLeft',({message})=>{
    appendSys(messages1v1,message); toast(message,'warn');
    S.inPair=false; S.currentRoom=null;
    setTimeout(()=>{ showView('queue'); sk.emit('join1v1'); },2000);
  });
  sk.on('leftQueue',()=>{
    S.inPair=false; S.currentRoom=null; showView('welcome');
    tbTitle.textContent='Choose a mode to start';
    roomInfoBox.classList.add('hidden'); roomCodeBadge.classList.add('hidden');
  });
  sk.on('codeError',({message})=>{ codeError.textContent=message; toast(message,'error'); });
  sk.on('notice',({type,msg})=>toast(msg,type));
  sk.on('error',({msg})=>toast(msg,'error'));
}

// ── Mode buttons ───────────────────────────────────────────────
modeBtns.forEach(btn=>{
  btn.addEventListener('click',()=>{
    modeBtns.forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    S.mode=btn.dataset.mode;
    roomParam.classList.add('hidden'); interestP.classList.add('hidden');
    codedParam.classList.add('hidden'); codeError.textContent='';
    if(S.mode==='room')     { roomParam.classList.remove('hidden'); roomInput.focus(); }
    if(S.mode==='interest') { interestP.classList.remove('hidden'); }
    if(S.mode==='coded')    { codedParam.classList.remove('hidden'); }
    if(S.mode==='random')   { doJoin('random'); closeSidebar(); }
    if(S.mode==='1v1')      { doJoin1v1(); closeSidebar(); }
  });
});

roomJoinBtn.addEventListener('click',()=>{ const v=roomInput.value.trim(); if(v){doJoin('room',v);closeSidebar();}else roomInput.focus(); });
roomInput.addEventListener('keydown',e=>{ if(e.key==='Enter') roomJoinBtn.click(); });

tagBtns.forEach(btn=>{
  btn.addEventListener('click',()=>{
    tagBtns.forEach(b=>b.classList.remove('sel')); btn.classList.add('sel');
    doJoin('interest',btn.dataset.tag); closeSidebar();
  });
});

createRoomBtn.addEventListener('click',()=>{
  if(!S.socket){toast('Not connected yet','warn');return;}
  S.socket.emit('createCodedRoom'); closeSidebar();
});
codeJoinBtn.addEventListener('click',()=>{
  const code=codeInput.value.trim();
  if(!code){codeError.textContent='Enter a 5-digit code.';return;}
  if(!/^\d{5}$/.test(code)){codeError.textContent='Must be exactly 5 digits.';return;}
  codeError.textContent='';
  if(!S.socket){toast('Not connected yet','warn');return;}
  S.socket.emit('joinByCode',{code}); closeSidebar();
});
codeInput.addEventListener('keydown',e=>{ if(e.key==='Enter') codeJoinBtn.click(); });

copyCodeBtn.addEventListener('click',()=>{
  const code=roomCodeDisp.textContent;
  if(code&&code!=='—') navigator.clipboard.writeText(code).then(()=>toast(`Code ${code} copied!`,'success')).catch(()=>toast('Copy: '+code,'warn',7000));
});

// ── Join helpers ───────────────────────────────────────────────
function doJoin(mode,param=''){
  if(!S.socket){toast('Not connected yet.','warn');return;}
  S.socket.emit('joinMode',{mode,param}); tbTitle.textContent='Joining…';
}
function doJoin1v1(){
  if(!S.socket){toast('Not connected yet.','warn');return;}
  clearMsgs(messages1v1); showView('queue');
  tbTitle.textContent='💬 Finding a partner…';
  roomInfoBox.classList.add('hidden'); roomCodeBadge.classList.add('hidden');
  S.socket.emit('join1v1');
}

leaveQBtn.addEventListener('click',()=>{ S.socket&&S.socket.emit('leave1v1'); });
skipBtn.addEventListener('click',()=>{ if(S.socket){S.socket.emit('skip1v1');clearMsgs(messages1v1);} });
leavePairBtn.addEventListener('click',()=>{ S.socket&&S.socket.emit('leave1v1'); });

// ── Messaging ──────────────────────────────────────────────────
function sendMsg(input){
  const msg=input.value.trim();
  if(!msg||!S.socket) return;
  S.socket.emit('chat message',{msg});
  input.value=''; input.focus();
  if(input===msgInput) updateCharCount('');
  clearTimeout(S.typingTimer);
  S.socket.emit('stopTyping');
}
chatForm.addEventListener('submit',e=>{ e.preventDefault(); sendMsg(msgInput); });
chatForm1v1.addEventListener('submit',e=>{ e.preventDefault(); sendMsg(msgInput1v1); });

function updateCharCount(val){
  const left=500-val.length;
  charCount.textContent=left;
  charCount.className='char-count'+(left<100?' warn':'')+(left<30?' danger':'');
}
msgInput.addEventListener('input',()=>{
  updateCharCount(msgInput.value);
  if(!S.socket) return;
  S.socket.emit('typing');
  clearTimeout(S.typingTimer);
  S.typingTimer=setTimeout(()=>S.socket&&S.socket.emit('stopTyping'),1500);
});
msgInput1v1.addEventListener('input',()=>{
  if(!S.socket) return;
  S.socket.emit('typing');
  clearTimeout(S.typingTimer);
  S.typingTimer=setTimeout(()=>S.socket&&S.socket.emit('stopTyping'),1500);
});

// Ctrl+Enter or Enter submits
[chatForm,chatForm1v1].forEach(f=>{
  f.querySelector('input').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); f.dispatchEvent(new Event('submit')); }
  });
});

// ── Reactions ─────────────────────────────────────────────────
document.querySelectorAll('.react-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    if(!S.socket||!S.currentRoom) return;
    S.socket.emit('reaction',{emoji:btn.dataset.emoji});
  });
});

function spawnFloatReaction(emoji,from){
  const el=document.createElement('div');
  el.className='float-react';
  el.textContent=emoji;
  el.style.left=(Math.random()*160-80)+'px';
  floatReact.appendChild(el);
  setTimeout(()=>el.remove(),1600);
  // Show small toast for who reacted
  const tc=$('toast-container'), t=document.createElement('div');
  t.className='toast info'; t.style.cssText='padding:.35rem .7rem;font-size:.75rem';
  t.innerHTML=`<span>${emoji}</span><span>${esc(from)}</span>`;
  tc.appendChild(t); setTimeout(()=>{ t.style.cssText+=';transition:.25s;opacity:0'; setTimeout(()=>t.remove(),260); },1500);
}

// ── Emoji picker ───────────────────────────────────────────────
document.querySelectorAll('.emoji-toggle').forEach(btn=>{
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const targetInput=$(btn.dataset.target);
    const rect=btn.getBoundingClientRect();
    emojiPicker.style.cssText=`position:fixed;bottom:${window.innerHeight-rect.top+8}px;left:${Math.min(rect.left,window.innerWidth-228)}px;right:auto`;
    S.activeEmojiTarget=targetInput;
    emojiPicker.classList.toggle('hidden');
  });
});
emojiPicker.querySelectorAll('span').forEach(s=>{
  s.addEventListener('click',()=>{
    if(S.activeEmojiTarget){ S.activeEmojiTarget.value+=s.textContent; S.activeEmojiTarget.focus(); }
  });
});
document.addEventListener('click',e=>{ if(!emojiPicker.contains(e.target)&&!e.target.classList.contains('emoji-toggle')) emojiPicker.classList.add('hidden'); });

// ── Message rendering ──────────────────────────────────────────
function appendMsg(box,nick,avatar,msg,ts,isMine,msgId){
  const row=document.createElement('div');
  row.className=`msg-row${isMine?' mine':''}`;
  if(msgId) row.dataset.msgId=msgId;
  row.innerHTML=`
    <div class="msg-ava">${esc(avatar||'🦊')}</div>
    <div class="msg-content">
      ${!isMine?`<span class="msg-nick">${esc(nick)}</span>`:''}
      <div class="msg-bubble">${esc(msg)}</div>
      <span class="msg-time">${fmtTime(ts)}</span>
    </div>`;
  box.appendChild(row);
  box.scrollTop=box.scrollHeight;
}
function appendSys(box,msg){
  const row=document.createElement('div');
  row.className='msg-row sys';
  row.innerHTML=`<div class="msg-bubble">${esc(msg)}</div>`;
  box.appendChild(row); box.scrollTop=box.scrollHeight;
}
function clearMsgs(box){ box.innerHTML=''; }

// ── Mobile sidebar ─────────────────────────────────────────────
sbToggle.addEventListener('click',()=>sidebar.classList.toggle('open'));
function closeSidebar(){ sidebar.classList.remove('open'); }
document.addEventListener('click',e=>{ if(!sidebar.contains(e.target)&&e.target!==sbToggle) closeSidebar(); });

// ── Init ───────────────────────────────────────────────────────
// (Terms modal is shown first, then captcha, then app)
// No auto-load captcha — wait for terms acceptance