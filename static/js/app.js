'use strict';
/* Hideout Chat — Client */

const S = {
  socket:null, nickname:'', avatar:'', mode:null,
  currentRoom:null, inPair:false, captchaId:null,
  typingTimer:null, activeView:'welcome', activeEmojiTarget:null,
};

const $ = id => document.getElementById(id);

// DOM refs
const ageGate      = $('age-gate');
const captchaQ     = $('captcha-q');
const captchaAns   = $('captcha-ans');
const captchaErr   = $('captcha-err');
const enterBtn     = $('enter-btn');
const appEl        = $('app');
const sidebar      = $('sidebar');
const sbToggle     = $('sidebar-toggle');
const myAvatar     = $('my-avatar');
const myNick       = $('my-nick');
const onlineCount  = $('online-count');
const modeBtns     = document.querySelectorAll('.mode-btn');
const roomParam    = $('room-param');
const roomInput    = $('room-input');
const roomJoinBtn  = $('room-join-btn');
const interestP    = $('interest-param');
const tagBtns      = document.querySelectorAll('.tag-btn');
const codedParam   = $('coded-param');
const createRoomBtn= $('create-room-btn');
const codeInput    = $('code-input');
const codeJoinBtn  = $('code-join-btn');
const codeError    = $('code-error');
const roomInfoBox  = $('room-info-box');
const ribName      = $('rib-name');
const ribCount     = $('rib-count');
const roomCodeBadge= $('room-code-badge');
const roomCodeDisp = $('room-code-display');
const copyCodeBtn  = $('copy-code-btn');
const tbTitle      = $('tb-title');
const tbStatus     = $('tb-status');
const messages     = $('messages');
const typingBar    = $('typing-bar');
const chatForm     = $('chat-form');
const msgInput     = $('msg-input');
const messages1v1  = $('messages-1v1');
const typingBar1v1 = $('typing-bar-1v1');
const chatForm1v1  = $('chat-form-1v1');
const msgInput1v1  = $('msg-input-1v1');
const qStatus      = $('q-status');
const qPos         = $('q-pos');
const qTotal       = $('q-total');
const leaveQBtn    = $('leave-queue-btn');
const skipBtn      = $('skip-btn');
const leavePairBtn = $('leave-pair-btn');
const emojiPicker  = $('emoji-picker');

const views = {
  welcome: $('view-welcome'),
  chat   : $('view-chat'),
  queue  : $('view-queue'),
  '1v1'  : $('view-1v1'),
};

// ── Utils ──────────────────────────────────────────────────────
function esc(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(ts){
  return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function toast(msg,type='info',dur=3500){
  const tc=$('toast-container');
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  const icons={info:'💬',warn:'⚠️',error:'❌',success:'✅'};
  el.innerHTML=`<span>${icons[type]||'ℹ️'}</span><span>${esc(msg)}</span>`;
  tc.appendChild(el);
  setTimeout(()=>{
    el.style.transition='.3s';el.style.opacity='0';el.style.transform='translateX(20px)';
    setTimeout(()=>el.remove(),300);
  },dur);
}
function showView(name){
  Object.entries(views).forEach(([k,v])=>{
    v.classList.toggle('active',k===name);
    v.classList.toggle('hidden',k!==name);
  });
  S.activeView=name;
}

// ── Captcha ────────────────────────────────────────────────────
async function loadCaptcha(){
  captchaQ.textContent='…';
  try{
    const r=await fetch('/generate-captcha');
    const d=await r.json();
    S.captchaId=d.id;
    captchaQ.textContent=`${d.question} = ?`;
    captchaAns.value=''; captchaErr.textContent='';
  }catch{ captchaQ.textContent='Error. Refresh page.'; }
}

enterBtn.addEventListener('click',async()=>{
  const ans=captchaAns.value.trim();
  if(!ans){captchaErr.textContent='Please enter the answer.';return;}
  enterBtn.disabled=true; enterBtn.textContent='Verifying…';
  try{
    const r=await fetch('/verify-captcha',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({captchaId:S.captchaId,answer:ans})
    });
    const d=await r.json();
    if(d.success){
      ageGate.style.display='none';
      appEl.classList.remove('hidden');
      initSocket();
    } else {
      captchaErr.textContent=d.message||'Wrong answer.';
      loadCaptcha();
    }
  }catch{captchaErr.textContent='Network error. Try again.';}
  enterBtn.disabled=false; enterBtn.textContent='Verify & Enter →';
});
captchaAns.addEventListener('keydown',e=>{if(e.key==='Enter')enterBtn.click();});

// ── Socket.IO connection ───────────────────────────────────────
function initSocket(){
  // CRITICAL FIX: polling FIRST so Render's proxy can handle the handshake,
  // then it upgrades to websocket automatically.
  S.socket = io({
    transports       : ['polling', 'websocket'],  // polling first!
    reconnection     : true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 20,
    timeout          : 20000,
    forceNew         : true,
  });

  const sk = S.socket;

  sk.on('connect',()=>{
    tbStatus.textContent='● Connected';
    tbStatus.className='tb-status connected';
    tbStatus.classList.remove('hidden');
    sk.emit('getOnlineCount');
    console.log('✅ Socket connected:', sk.id, '| transport:', sk.io.engine.transport.name);
  });

  sk.on('connect_error',(err)=>{
    console.error('❌ Connection error:', err.message);
    tbStatus.textContent='● Connecting…';
    tbStatus.className='tb-status disconnected';
    tbStatus.classList.remove('hidden');
  });

  sk.on('disconnect',(reason)=>{
    tbStatus.textContent='● Disconnected';
    tbStatus.className='tb-status disconnected';
    tbStatus.classList.remove('hidden');
    console.warn('🔌 Disconnected:', reason);
    toast('Disconnected. Reconnecting…','warn');
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
      tbTitle.textContent=`🔐 Private Room · ${code}`;
    } else {
      roomCodeBadge.classList.add('hidden');
      tbTitle.textContent=`# ${label} · ${userCount} online`;
    }
    showView('chat');
    clearMsgs(messages);
    msgInput.focus();
  });

  sk.on('roomUpdate',({userCount,roomName})=>{
    ribCount.textContent=userCount;
    if(S.mode!=='1v1'){
      const label=roomName.replace(/^(room_|interest_|global_|coded_)/,'')||roomName;
      const codeTxt=roomCodeDisp.textContent;
      if(codeTxt&&codeTxt!=='—') tbTitle.textContent=`🔐 Private Room · ${codeTxt}`;
      else tbTitle.textContent=`# ${label} · ${userCount} online`;
    }
  });

  sk.on('chat message',({nickname,avatar,msg,timestamp,type})=>{
    const box=S.activeView==='1v1'?messages1v1:messages;
    if(type==='system') appendSys(box,msg);
    else appendMsg(box,nickname,avatar,msg,timestamp,nickname===S.nickname);
  });

  sk.on('typing',name=>{
    const bar=S.activeView==='1v1'?typingBar1v1:typingBar;
    bar.innerHTML=`<span class="typing-dots"></span> ${esc(name)} is typing`;
    bar.classList.remove('hidden');
  });
  sk.on('stopTyping',()=>{typingBar.classList.add('hidden');typingBar1v1.classList.add('hidden');});

  sk.on('queueStatus',({position,total,message})=>{
    qPos.textContent=position;
    qTotal.textContent=total>1?`of ${total}`:'';
    qStatus.textContent=message||'Searching…';
  });

  sk.on('matched',({partnerName,partnerAvatar,roomId})=>{
    S.currentRoom=roomId; S.inPair=true;
    clearMsgs(messages1v1);
    appendSys(messages1v1,`${partnerAvatar} Matched with ${partnerName}! Say hi 👋`);
    tbTitle.textContent=`💬 Chatting with ${partnerAvatar} ${partnerName}`;
    showView('1v1'); toast(`Matched with ${partnerAvatar} ${partnerName}!`,'success');
    msgInput1v1.focus();
  });

  sk.on('partnerLeft',({message})=>{
    appendSys(messages1v1,message); toast(message,'warn');
    S.inPair=false; S.currentRoom=null;
    setTimeout(()=>{showView('queue');sk.emit('join1v1');},2000);
  });

  sk.on('leftQueue',()=>{
    S.inPair=false; S.currentRoom=null;
    showView('welcome'); tbTitle.textContent='Choose a mode to start';
    roomInfoBox.classList.add('hidden'); roomCodeBadge.classList.add('hidden');
  });

  sk.on('codeError',({message})=>{codeError.textContent=message;toast(message,'error');});
  sk.on('notice',({type,msg})=>toast(msg,type));
  sk.on('error',({msg})=>toast(msg,'error'));
}

// ── Mode buttons ───────────────────────────────────────────────
modeBtns.forEach(btn=>{
  btn.addEventListener('click',()=>{
    modeBtns.forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    S.mode=btn.dataset.mode;
    roomParam.classList.add('hidden');
    interestP.classList.add('hidden');
    codedParam.classList.add('hidden');
    codeError.textContent='';
    if(S.mode==='room')     {roomParam.classList.remove('hidden');roomInput.focus();}
    if(S.mode==='interest') {interestP.classList.remove('hidden');}
    if(S.mode==='coded')    {codedParam.classList.remove('hidden');}
    if(S.mode==='random')   {doJoin('random');closeSidebar();}
    if(S.mode==='1v1')      {doJoin1v1();closeSidebar();}
  });
});

roomJoinBtn.addEventListener('click',()=>{
  const v=roomInput.value.trim();
  if(v){doJoin('room',v);closeSidebar();}
  else roomInput.focus();
});
roomInput.addEventListener('keydown',e=>{if(e.key==='Enter')roomJoinBtn.click();});

tagBtns.forEach(btn=>{
  btn.addEventListener('click',()=>{
    tagBtns.forEach(b=>b.classList.remove('sel'));
    btn.classList.add('sel');
    doJoin('interest',btn.dataset.tag);
    closeSidebar();
  });
});

createRoomBtn.addEventListener('click',()=>{
  if(!S.socket){toast('Not connected yet','warn');return;}
  S.socket.emit('createCodedRoom');
  closeSidebar();
});

codeJoinBtn.addEventListener('click',()=>{
  const code=codeInput.value.trim();
  if(!code){codeError.textContent='Enter a 5-digit code.';return;}
  if(!/^\d{5}$/.test(code)){codeError.textContent='Must be exactly 5 digits.';return;}
  codeError.textContent='';
  if(!S.socket){toast('Not connected yet','warn');return;}
  S.socket.emit('joinByCode',{code});
  closeSidebar();
});
codeInput.addEventListener('keydown',e=>{if(e.key==='Enter')codeJoinBtn.click();});

copyCodeBtn.addEventListener('click',()=>{
  const code=roomCodeDisp.textContent;
  if(code&&code!=='—'){
    navigator.clipboard.writeText(code)
      .then(()=>toast(`Code ${code} copied!`,'success'))
      .catch(()=>toast('Copy manually: '+code,'warn',6000));
  }
});

// ── Join helpers ───────────────────────────────────────────────
function doJoin(mode,param=''){
  if(!S.socket){toast('Not connected yet. Wait a moment.','warn');return;}
  S.socket.emit('joinMode',{mode,param});
  tbTitle.textContent='Joining…';
}

function doJoin1v1(){
  if(!S.socket){toast('Not connected yet.','warn');return;}
  clearMsgs(messages1v1);
  showView('queue');
  tbTitle.textContent='💬 Finding a partner…';
  roomInfoBox.classList.add('hidden');
  roomCodeBadge.classList.add('hidden');
  S.socket.emit('join1v1');
}

leaveQBtn.addEventListener('click',()=>{S.socket&&S.socket.emit('leave1v1');});
skipBtn.addEventListener('click',()=>{if(S.socket){S.socket.emit('skip1v1');clearMsgs(messages1v1);}});
leavePairBtn.addEventListener('click',()=>{S.socket&&S.socket.emit('leave1v1');});

// ── Messaging ──────────────────────────────────────────────────
function sendMsg(input){
  const msg=input.value.trim();
  if(!msg||!S.socket)return;
  S.socket.emit('chat message',{msg});
  input.value=''; input.focus();
  clearTimeout(S.typingTimer);
  S.socket.emit('stopTyping');
}

chatForm.addEventListener('submit',e=>{e.preventDefault();sendMsg(msgInput);});
chatForm1v1.addEventListener('submit',e=>{e.preventDefault();sendMsg(msgInput1v1);});

function setupTyping(input){
  input.addEventListener('input',()=>{
    if(!S.socket)return;
    S.socket.emit('typing');
    clearTimeout(S.typingTimer);
    S.typingTimer=setTimeout(()=>S.socket&&S.socket.emit('stopTyping'),1500);
  });
}
setupTyping(msgInput);
setupTyping(msgInput1v1);

// ── Emoji ──────────────────────────────────────────────────────
document.querySelectorAll('.emoji-toggle').forEach(btn=>{
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const targetInput=$(btn.dataset.target);
    const rect=btn.getBoundingClientRect();
    emojiPicker.style.position='fixed';
    emojiPicker.style.bottom=(window.innerHeight-rect.top+8)+'px';
    emojiPicker.style.left=Math.min(rect.left,window.innerWidth-230)+'px';
    emojiPicker.style.right='auto';
    S.activeEmojiTarget=targetInput;
    emojiPicker.classList.toggle('hidden');
  });
});
emojiPicker.querySelectorAll('span').forEach(s=>{
  s.addEventListener('click',()=>{
    if(S.activeEmojiTarget){S.activeEmojiTarget.value+=s.textContent;S.activeEmojiTarget.focus();}
  });
});
document.addEventListener('click',e=>{
  if(!emojiPicker.contains(e.target)&&!e.target.classList.contains('emoji-toggle'))
    emojiPicker.classList.add('hidden');
});

// ── Render ────────────────────────────────────────────────────
function appendMsg(box,nick,avatar,msg,ts,isMine){
  const row=document.createElement('div');
  row.className=`msg-row${isMine?' mine':''}`;
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
  box.appendChild(row);
  box.scrollTop=box.scrollHeight;
}
function clearMsgs(box){box.innerHTML='';}

// ── Mobile sidebar ─────────────────────────────────────────────
sbToggle.addEventListener('click',()=>sidebar.classList.toggle('open'));
function closeSidebar(){sidebar.classList.remove('open');}
document.addEventListener('click',e=>{
  if(!sidebar.contains(e.target)&&e.target!==sbToggle) closeSidebar();
});

// ── Boot ───────────────────────────────────────────────────────
loadCaptcha();