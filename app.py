import os, time, random, string, logging, re
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger(__name__)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-change-in-prod')

def _get_async_mode():
    try:
        import gevent; return 'gevent'
    except ImportError: pass
    try:
        import eventlet; return 'eventlet'
    except ImportError: pass
    return 'threading'

ASYNC_MODE = _get_async_mode()
log.info(f"async_mode={ASYNC_MODE}")

socketio = SocketIO(app, cors_allowed_origins="*", async_mode=ASYNC_MODE,
    ping_timeout=60, ping_interval=25, max_http_buffer_size=1_000_000,
    logger=False, engineio_logger=False, allow_upgrades=True, cookie=None)

limiter = Limiter(key_func=get_remote_address, app=app,
    default_limits=["300 per 15 minutes"], storage_uri="memory://")

@app.after_request
def sec_headers(r):
    r.headers['X-Content-Type-Options']='nosniff'
    r.headers['X-Frame-Options']='DENY'
    r.headers['X-XSS-Protection']='1; mode=block'
    r.headers['Referrer-Policy']='no-referrer'
    return r

MAX_CONNECTIONS=2000; MAX_CONNECTIONS_PER_IP=10
MESSAGE_RATE_LIMIT=20; RATE_WINDOW=60; MAX_MSG_LEN=500
CAPTCHA_TTL=300; CLEANUP_INTERVAL=120; TERMS_VERSION="v2.0"

ADJECTIVES=["Silent","Wild","Happy","Crazy","Mysterious","Swift","Noble","Brave","Clever","Gentle","Fierce","Wise","Bold","Quick","Calm","Bright","Cool","Lucky","Strong","Free","Dark","Cosmic","Arctic","Storm","Shadow","Rusty","Velvet","Frozen","Savage","Mystic","Jumpy","Grumpy","Sneaky","Fluffy","Bouncy"]
ANIMALS=["Fox","Wolf","Eagle","Panda","Tiger","Lion","Bear","Hawk","Owl","Deer","Lynx","Raven","Snake","Shark","Whale","Dolphin","Phoenix","Dragon","Griffin","Falcon","Jaguar","Panther","Cobra","Viper","Mantis","Badger","Coyote","Gecko","Orca","Sparrow","Platypus","Narwhal","Axolotl","Quokka","Capybara"]
AVATARS=["🦊","🐺","🦅","🐼","🐯","🦁","🐻","🦆","🦉","🦌","🐱","🐦","🐍","🦈","🐋","🐬","🔥","🐉","⚡","🌙","💫","🌟","🎭","🎪","👾","🤖","👻","💀","🎯","🌈","🦋","🐙","🦂","🐲","🌊","❄️","🍄","🦎","🐊","🦜","🧸","🎃","🍕","🌮","🎮"]

# Interest categories with emoji and color
INTEREST_CATEGORIES = {
    "🎮 Gaming": ["fps","rpg","minecraft","anime-games","mobile-games","retro-games","esports","indie"],
    "🎵 Music": ["hiphop","rock","edm","lofi","kpop","classical","jazz","metal","pop"],
    "📺 Pop Culture": ["anime","manga","movies","series","memes","celebrity","tiktok","youtube"],
    "💻 Tech": ["coding","ai","crypto","hacking","linux","gadgets","startups","web3"],
    "🌍 Life": ["travel","food","fitness","fashion","photography","books","art","cooking"],
    "💬 Talk": ["vent","confession","debate","advice","random","philosophy","politics","spirituality"],
}

BAD_WORDS={'spam','phish','scam'}

# State
connection_limiter={}; message_rates={}; captcha_store={}
rooms={}; user_rooms={}; room_stats={}
room_codes={}; code_owners={}
waiting_queue=[]; active_pairs={}; pair_counter=[0]
socket_meta={}; last_cleanup=[time.time()]
# NEW: polls store   room_id -> {question, options:[{text,votes}], creator_sid, created_at}
active_polls={}
# NEW: confessions board (global, last 50)
confessions=[]

perf={'start_time':time.time(),'total_connections':0,'total_messages':0,'peak_connections':0}

def rnd_name():   return f"{random.choice(ADJECTIVES)}{random.choice(ANIMALS)}{random.randint(100,999)}"
def rnd_avatar(): return random.choice(AVATARS)

def make_captcha():
    n1,n2=random.randint(1,20),random.randint(1,20)
    op=random.choice(['+','-','*'])
    if op=='+': return f"{n1} + {n2}",n1+n2
    elif op=='-': a,b=max(n1,n2),min(n1,n2); return f"{a} - {b}",a-b
    else: s1,s2=random.randint(1,10),random.randint(1,10); return f"{s1} × {s2}",s1*s2

def sanitize(msg):
    if not msg or not isinstance(msg,str): return None
    msg=re.sub(r'<[^>]+>','',msg); msg=re.sub(r'\s+',' ',msg).strip()
    return msg if msg else None

def valid_msg(msg):
    if not msg: return False,'empty'
    if len(msg)>MAX_MSG_LEN: return False,'too_long'
    if any(w in msg.lower() for w in BAD_WORDS): return False,'blocked'
    return True,'ok'

def check_rate(sid):
    now=time.time()
    r=message_rates.setdefault(sid,{'count':0,'reset_time':now+RATE_WINDOW})
    if now>r['reset_time']: r['count'],r['reset_time']=0,now+RATE_WINDOW
    if r['count']>=MESSAGE_RATE_LIMIT: return False
    r['count']+=1; return True

def ts(): return int(time.time()*1000)
def sys_msg(room,text): socketio.emit('chat message',{'nickname':'System','avatar':'📻','msg':text,'timestamp':ts(),'type':'system'},to=room)

def gen_code():
    while True:
        c=str(random.randint(10000,99999))
        if c not in room_codes: return c

def get_ip():
    fwd=request.environ.get('HTTP_X_FORWARDED_FOR','')
    return fwd.split(',')[0].strip() if fwd else (request.remote_addr or '0.0.0.0')

def cleanup():
    now=time.time()
    if now-last_cleanup[0]<CLEANUP_INTERVAL: return
    last_cleanup[0]=now
    for k in [k for k,v in captcha_store.items() if now>v['expires']]: captcha_store.pop(k,None)
    for k in [k for k,v in message_rates.items() if now>v['reset_time']+RATE_WINDOW*2]: message_rates.pop(k,None)

def add_to_room(sid,room_key):
    remove_from_room(sid)
    rooms.setdefault(room_key,set()); room_stats.setdefault(room_key,{'created':time.time(),'max_users':0,'total_messages':0,'last_activity':time.time()})
    rooms[room_key].add(sid); user_rooms[sid]=room_key; join_room(room_key)
    if sid in socket_meta: socket_meta[sid]['room']=room_key
    rs=room_stats[room_key]; rs['max_users']=max(rs['max_users'],len(rooms[room_key])); rs['last_activity']=time.time()
    socketio.emit('roomUpdate',{'userCount':len(rooms[room_key]),'roomName':room_key},to=room_key)

def remove_from_room(sid):
    room_key=user_rooms.pop(sid,None)
    if not room_key: return
    if room_key in rooms:
        rooms[room_key].discard(sid); leave_room(room_key,sid=sid)
        socketio.emit('roomUpdate',{'userCount':len(rooms[room_key]),'roomName':room_key},to=room_key)
        if not rooms[room_key]:
            rooms.pop(room_key,None); room_stats.pop(room_key,None)
            active_polls.pop(room_key,None)
            for code,rk in list(room_codes.items()):
                if rk==room_key: room_codes.pop(code,None); code_owners.pop(room_key,None)
    if sid in socket_meta: socket_meta[sid]['room']=None

def push_q():
    for i,u in enumerate(waiting_queue):
        socketio.emit('queueStatus',{'position':i+1,'total':len(waiting_queue),'message':"You're next!" if i==0 else f"Position {i+1}"},to=u['sid'])

def run_match():
    while len(waiting_queue)>=2:
        u1=waiting_queue.pop(0); u2=waiting_queue.pop(0)
        pair_counter[0]+=1; rid=f"pair_{pair_counter[0]}_{int(time.time())}"
        active_pairs[u1['sid']]={'room_id':rid,'partner_id':u2['sid'],'partner_name':u2['nickname'],'partner_avatar':u2['avatar']}
        active_pairs[u2['sid']]={'room_id':rid,'partner_id':u1['sid'],'partner_name':u1['nickname'],'partner_avatar':u1['avatar']}
        for sid in (u1['sid'],u2['sid']):
            try: socketio.server.enter_room(sid,rid)
            except: pass
            if sid in socket_meta: socket_meta[sid]['room']=rid
        socketio.emit('matched',{'partnerName':u2['nickname'],'partnerAvatar':u2['avatar'],'roomId':rid},to=u1['sid'])
        socketio.emit('matched',{'partnerName':u1['nickname'],'partnerAvatar':u1['avatar'],'roomId':rid},to=u2['sid'])
        sys_msg(rid,"You've been matched! 👋 Say hi!")
    push_q()

def enqueue(sid):
    m=socket_meta.get(sid,{})
    if any(u['sid']==sid for u in waiting_queue): return
    waiting_queue.append({'sid':sid,'nickname':m.get('nickname','User'),'avatar':m.get('avatar','🎮'),'join_time':time.time()})
    socketio.emit('queueStatus',{'position':len(waiting_queue),'total':len(waiting_queue),'message':'Searching…'},to=sid)
    run_match()

def dequeue(sid):
    global waiting_queue
    before=len(waiting_queue); waiting_queue=[u for u in waiting_queue if u['sid']!=sid]
    if len(waiting_queue)<before: push_q()

def end_pair(sid,skipped=False):
    info=active_pairs.pop(sid,None)
    if not info: return
    partner=info['partner_id']; active_pairs.pop(partner,None); rid=info['room_id']
    nick=socket_meta.get(sid,{}).get('nickname','Partner')
    socketio.emit('partnerLeft',{'message':"Partner skipped." if skipped else f"{nick} disconnected."},to=partner)
    for s in (sid,partner):
        try: socketio.server.leave_room(s,rid)
        except: pass
        if s in socket_meta: socket_meta[s]['room']=None

# ── HTTP ──────────────────────────────────────────────────────────────────────
@app.route('/')
def index(): return render_template('index.html', interest_categories=INTEREST_CATEGORIES, terms_version=TERMS_VERSION)

@app.route('/generate-captcha')
@limiter.limit("30 per minute")
def gen_captcha():
    cleanup(); q,a=make_captcha()
    cid=''.join(random.choices(string.ascii_lowercase+string.digits,k=12))
    captcha_store[cid]={'answer':a,'expires':time.time()+CAPTCHA_TTL}
    return jsonify({'id':cid,'question':q})

@app.route('/verify-captcha',methods=['POST'])
@limiter.limit("20 per minute")
def verify_captcha():
    data=request.get_json(silent=True) or {}
    if not data.get('termsAccepted'): return jsonify({'success':False,'message':'Accept terms first.'})
    entry=captcha_store.get(data.get('captchaId',''))
    if not entry or time.time()>entry['expires']: return jsonify({'success':False,'message':'Captcha expired.'})
    try:
        if int(data.get('answer','x'))==entry['answer']:
            captcha_store.pop(data.get('captchaId'),None); return jsonify({'success':True})
    except: pass
    return jsonify({'success':False,'message':'Wrong answer!'})

@app.route('/health')
def health(): return jsonify({'status':'ok','async_mode':ASYNC_MODE,'connections':len(socket_meta),'rooms':len(rooms),'messages':perf['total_messages']})

# ── Socket ─────────────────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    sid=request.sid; ip=get_ip()
    if len(socket_meta)>=MAX_CONNECTIONS: return False
    cnt=connection_limiter.get(ip,0)
    if cnt>=MAX_CONNECTIONS_PER_IP: return False
    connection_limiter[ip]=cnt+1
    nick=rnd_name(); avatar=rnd_avatar()
    socket_meta[sid]={'nickname':nick,'avatar':avatar,'room':None,'ip':ip,'joined_at':time.time(),'msg_count':0}
    perf['total_connections']+=1; perf['peak_connections']=max(perf['peak_connections'],len(socket_meta))
    emit('welcome',{'nickname':nick,'avatar':avatar,'online':len(socket_meta),'categories':INTEREST_CATEGORIES})
    socketio.emit('onlineCount',{'count':len(socket_meta)})
    log.info(f"🔗 {nick} | total={len(socket_meta)}")

@socketio.on('disconnect')
def on_disconnect():
    sid=request.sid; meta=socket_meta.pop(sid,{}); nick=meta.get('nickname','?'); ip=meta.get('ip')
    if ip:
        cnt=connection_limiter.get(ip,1)
        if cnt>1: connection_limiter[ip]=cnt-1
        else: connection_limiter.pop(ip,None)
    message_rates.pop(sid,None); dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    room=user_rooms.get(sid)
    if room: sys_msg(room,f"{nick} left the chat 👋"); remove_from_room(sid)
    socketio.emit('onlineCount',{'count':len(socket_meta)})

@socketio.on('joinMode')
def on_join_mode(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    if isinstance(data,dict): mode=data.get('mode','random'); param=(data.get('param') or '').strip()[:30]
    else: mode=str(data); param=''
    param=re.sub(r'[^a-zA-Z0-9_\-]','',param)
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    if mode=='random': room_key='global_random'
    elif mode=='room' and param: room_key=f"room_{param.lower()}"
    elif mode=='interest' and param: room_key=f"interest_{param.lower().replace(' ','_')}"
    else: room_key='global_random'
    add_to_room(sid,room_key)
    sys_msg(room_key,f"{meta['nickname']} {meta['avatar']} joined!")
    code=next((c for c,rk in room_codes.items() if rk==room_key),None)
    # Send existing poll if any
    poll=active_polls.get(room_key)
    emit('joinedRoom',{'room':room_key,'userCount':len(rooms.get(room_key,set())),'code':code,'isOwner':code_owners.get(room_key)==sid,'poll':poll})

@socketio.on('createCodedRoom')
def on_create_coded():
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    code=gen_code(); room_key=f"coded_{code}"
    room_codes[code]=room_key; code_owners[room_key]=sid
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    add_to_room(sid,room_key)
    sys_msg(room_key,f"🔐 Private room created! Code: {code}")
    emit('joinedRoom',{'room':room_key,'userCount':1,'code':code,'isOwner':True,'poll':None})

@socketio.on('joinByCode')
def on_join_by_code(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    code=str(data.get('code','')).strip()
    if not re.match(r'^\d{5}$',code): emit('codeError',{'message':'Must be 5 digits.'}); return
    room_key=room_codes.get(code)
    if not room_key: emit('codeError',{'message':'Room not found!'}); return
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    add_to_room(sid,room_key)
    sys_msg(room_key,f"{meta['nickname']} {meta['avatar']} joined with code 🔑")
    poll=active_polls.get(room_key)
    emit('joinedRoom',{'room':room_key,'userCount':len(rooms.get(room_key,set())),'code':code,'isOwner':False,'poll':poll})

@socketio.on('join1v1')
def on_join_1v1():
    sid=request.sid
    if not socket_meta.get(sid): return
    remove_from_room(sid); enqueue(sid)

@socketio.on('skip1v1')
def on_skip():
    sid=request.sid
    if sid in active_pairs:
        partner=active_pairs[sid]['partner_id']; end_pair(sid,skipped=True); enqueue(sid); enqueue(partner)

@socketio.on('leave1v1')
def on_leave_1v1():
    sid=request.sid; dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    emit('leftQueue')

@socketio.on('chat message')
def on_message(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    raw=(data if isinstance(data,str) else data.get('msg','')).strip()
    msg=sanitize(raw); reply_to=data.get('replyTo') if isinstance(data,dict) else None
    if not check_rate(sid): emit('notice',{'type':'warn','msg':'Slow down! Too many messages.'}); return
    ok,reason=valid_msg(msg)
    if not ok: emit('notice',{'type':'error','msg':'Message not allowed.'}); return
    room=meta.get('room')
    if not room: emit('notice',{'type':'error','msg':'Join a room first!'}); return
    meta['msg_count']+=1
    if room in room_stats: room_stats[room]['total_messages']+=1; room_stats[room]['last_activity']=time.time()
    perf['total_messages']+=1
    socketio.emit('chat message',{'nickname':meta['nickname'],'avatar':meta['avatar'],'msg':msg[:MAX_MSG_LEN],'timestamp':ts(),'type':'user','msgId':''.join(random.choices(string.ascii_lowercase+string.digits,k=8)),'replyTo':reply_to},to=room)

@socketio.on('reaction')
def on_reaction(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    room=meta.get('room')
    if not room: return
    ALLOWED=['👍','❤️','😂','🔥','😮','👏','💯','🎉','💀','🤡']
    emoji=str(data.get('emoji',''))
    if emoji not in ALLOWED: return
    socketio.emit('reaction',{'emoji':emoji,'from':meta['nickname']},to=room)

# NEW: Create a poll
@socketio.on('createPoll')
def on_create_poll(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    room=meta.get('room')
    if not room: return
    question=sanitize(str(data.get('question','')))[:100]
    options=[sanitize(str(o))[:50] for o in data.get('options',[]) if o][:4]
    if not question or len(options)<2: return
    poll={'question':question,'options':[{'text':o,'votes':0,'voters':[]} for o in options],'creator':meta['nickname'],'created_at':ts()}
    active_polls[room]=poll
    socketio.emit('pollCreated',poll,to=room)
    sys_msg(room,f"📊 {meta['nickname']} started a poll: {question}")

# NEW: Vote on a poll
@socketio.on('votePoll')
def on_vote_poll(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    room=meta.get('room')
    if not room: return
    poll=active_polls.get(room)
    if not poll: return
    idx=int(data.get('optionIndex',-1))
    if idx<0 or idx>=len(poll['options']): return
    # Check already voted
    if any(sid in opt['voters'] for opt in poll['options']): emit('notice',{'type':'warn','msg':'Already voted!'}); return
    poll['options'][idx]['votes']+=1; poll['options'][idx]['voters'].append(sid)
    socketio.emit('pollUpdated',poll,to=room)

# NEW: Anonymous confession to global board
@socketio.on('postConfession')
def on_confession(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    msg=sanitize(str(data.get('msg','')))[:300]
    ok,_=valid_msg(msg)
    if not ok: return
    mood=data.get('mood','😶')
    MOODS=['😶','😭','😡','🥺','😍','😂','🤯','😱','🫣','🥳']
    if mood not in MOODS: mood='😶'
    entry={'id':''.join(random.choices(string.ascii_lowercase+string.digits,k=8)),'msg':msg,'mood':mood,'ts':ts(),'likes':0,'liked_by':[]}
    confessions.insert(0,entry)
    if len(confessions)>50: confessions.pop()
    socketio.emit('newConfession',entry)
    emit('notice',{'type':'success','msg':'Confession posted anonymously 🤫'})

# NEW: Like a confession
@socketio.on('likeConfession')
def on_like_confession(data):
    sid=request.sid
    cid=str(data.get('id',''))
    c=next((x for x in confessions if x['id']==cid),None)
    if not c: return
    if sid in c['liked_by']: return
    c['likes']+=1; c['liked_by'].append(sid)
    socketio.emit('confessionLiked',{'id':cid,'likes':c['likes']})

@app.route('/confessions')
def get_confessions():
    return jsonify([{k:v for k,v in c.items() if k!='liked_by'} for c in confessions])

@socketio.on('typing')
def on_typing():
    sid=request.sid; meta=socket_meta.get(sid,{}); room=meta.get('room')
    if room: emit('typing',meta.get('nickname',''),to=room,skip_sid=sid)

@socketio.on('stopTyping')
def on_stop_typing():
    sid=request.sid; meta=socket_meta.get(sid,{}); room=meta.get('room')
    if room: emit('stopTyping',meta.get('nickname',''),to=room,skip_sid=sid)

@socketio.on('getOnlineCount')
def on_get_online(): emit('onlineCount',{'count':len(socket_meta)})

@socketio.on('ping')
def on_ping(): emit('pong',{'ts':ts()})

if __name__=='__main__':
    port=int(os.environ.get('PORT',8080))
    log.info(f"🚀 Hideout Retro running → http://0.0.0.0:{port} [{ASYNC_MODE}]")
    socketio.run(app,host='0.0.0.0',port=port,debug=False,allow_unsafe_werkzeug=True)