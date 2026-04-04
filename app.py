import os, time, random, string, logging, hashlib, re
from flask import Flask, render_template, request, jsonify, make_response
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

logging.basicConfig(level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
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

# ── Security headers ──────────────────────────────────────────────────────────
@app.after_request
def add_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
    return response

# ── Constants ─────────────────────────────────────────────────────────────────
MAX_CONNECTIONS        = 2000
MAX_CONNECTIONS_PER_IP = 10
MESSAGE_RATE_LIMIT     = 20
RATE_WINDOW            = 60
MAX_MSG_LEN            = 500
CAPTCHA_TTL            = 300
CLEANUP_INTERVAL       = 120
TERMS_VERSION          = "v1.0"   # bump this to force re-acceptance

ADJECTIVES = ["Silent","Wild","Happy","Crazy","Mysterious","Swift","Noble","Brave",
    "Clever","Gentle","Fierce","Wise","Bold","Quick","Calm","Bright","Cool","Smart",
    "Lucky","Strong","Free","Kind","Pure","True","Dark","Cyber","Neon","Cosmic",
    "Lunar","Solar","Arctic","Storm","Shadow","Rusty","Velvet","Frozen","Savage","Mystic"]
ANIMALS = ["Fox","Wolf","Eagle","Panda","Tiger","Lion","Bear","Hawk","Owl","Deer",
    "Lynx","Raven","Snake","Shark","Whale","Dolphin","Phoenix","Dragon","Griffin",
    "Falcon","Jaguar","Panther","Cobra","Viper","Mantis","Badger","Coyote","Osprey",
    "Mamba","Gecko","Orca","Sparrow","Kraken","Yeti","Bison","Lynx","Stallion"]
AVATARS = ["🦊","🐺","🦅","🐼","🐯","🦁","🐻","🦆","🦉","🦌","🐱","🐦","🐍",
    "🦈","🐋","🐬","🔥","🐉","⚡","🌙","💫","🌟","🎭","🎪","👾","🤖","👻",
    "💀","🎯","🌈","🦋","🐙","🦂","🐲","🌊","❄️","🍄","🦁","🦎","🐊"]
INTERESTS = ["gaming","music","movies","sports","tech","anime","travel","art",
    "books","food","fitness","crypto","science","fashion","photography","cooking",
    "memes","politics","history","nature"]

# Words that are completely blocked
BLOCKED_WORDS = {'spam','phish','scam'}
# Words that trigger a warning but are allowed
WARN_WORDS = {'hack','admin','moderator'}

# ── State ─────────────────────────────────────────────────────────────────────
connection_limiter = {}
message_rates      = {}
captcha_store      = {}
rooms              = {}
user_rooms         = {}
room_stats         = {}
room_codes         = {}
code_owners        = {}
waiting_queue      = []
active_pairs       = {}
pair_counter       = [0]
socket_meta        = {}
last_cleanup       = [time.time()]
perf = {'start_time':time.time(),'total_connections':0,'total_messages':0,'peak_connections':0}

# ── Helpers ───────────────────────────────────────────────────────────────────
def rnd_name():   return f"{random.choice(ADJECTIVES)}{random.choice(ANIMALS)}{random.randint(100,999)}"
def rnd_avatar(): return random.choice(AVATARS)

def make_captcha():
    n1,n2 = random.randint(1,20),random.randint(1,20)
    op = random.choice(['+','-','*'])
    if op=='+':  return f"{n1} + {n2}", n1+n2
    elif op=='-': a,b=max(n1,n2),min(n1,n2); return f"{a} - {b}", a-b
    else: s1,s2=random.randint(1,10),random.randint(1,10); return f"{s1} × {s2}", s1*s2

def sanitize_message(msg):
    """Remove HTML tags and normalise whitespace."""
    if not msg or not isinstance(msg, str): return None
    msg = re.sub(r'<[^>]+>', '', msg)        # strip HTML tags
    msg = re.sub(r'\s+', ' ', msg).strip()   # collapse whitespace
    return msg if msg else None

def valid_msg(msg):
    if not msg: return False, 'empty'
    if len(msg) > MAX_MSG_LEN: return False, 'too_long'
    low = msg.lower()
    if any(w in low for w in BLOCKED_WORDS): return False, 'blocked'
    return True, 'ok'

def check_rate(sid):
    now = time.time()
    r = message_rates.setdefault(sid,{'count':0,'reset_time':now+RATE_WINDOW})
    if now>r['reset_time']: r['count'],r['reset_time']=0,now+RATE_WINDOW
    if r['count']>=MESSAGE_RATE_LIMIT: return False
    r['count']+=1; return True

def ts(): return int(time.time()*1000)

def sys_msg(room, text):
    socketio.emit('chat message',
        {'nickname':'System','avatar':'🔒','msg':text,'timestamp':ts(),'type':'system'}, to=room)

def gen_code():
    while True:
        c=str(random.randint(10000,99999))
        if c not in room_codes: return c

def get_ip():
    fwd = request.environ.get('HTTP_X_FORWARDED_FOR','')
    return fwd.split(',')[0].strip() if fwd else (request.remote_addr or '0.0.0.0')

def cleanup():
    now=time.time()
    if now-last_cleanup[0]<CLEANUP_INTERVAL: return
    last_cleanup[0]=now
    for k in [k for k,v in captcha_store.items() if now>v['expires']]: captcha_store.pop(k,None)
    for k in [k for k,v in message_rates.items() if now>v['reset_time']+RATE_WINDOW*2]: message_rates.pop(k,None)

# ── Room management ───────────────────────────────────────────────────────────
def add_to_room(sid, room_key):
    remove_from_room(sid)
    rooms.setdefault(room_key,set())
    room_stats.setdefault(room_key,{'created':time.time(),'max_users':0,'total_messages':0,'last_activity':time.time()})
    rooms[room_key].add(sid); user_rooms[sid]=room_key; join_room(room_key)
    if sid in socket_meta: socket_meta[sid]['room']=room_key
    rs=room_stats[room_key]
    rs['max_users']=max(rs['max_users'],len(rooms[room_key])); rs['last_activity']=time.time()
    socketio.emit('roomUpdate',{'userCount':len(rooms[room_key]),'roomName':room_key},to=room_key)

def remove_from_room(sid):
    room_key=user_rooms.pop(sid,None)
    if not room_key: return
    if room_key in rooms:
        rooms[room_key].discard(sid); leave_room(room_key,sid=sid)
        socketio.emit('roomUpdate',{'userCount':len(rooms[room_key]),'roomName':room_key},to=room_key)
        if not rooms[room_key]:
            rooms.pop(room_key,None); room_stats.pop(room_key,None)
            for code,rk in list(room_codes.items()):
                if rk==room_key: room_codes.pop(code,None); code_owners.pop(room_key,None)
    if sid in socket_meta: socket_meta[sid]['room']=None

# ── Queue ─────────────────────────────────────────────────────────────────────
def push_q():
    for i,u in enumerate(waiting_queue):
        socketio.emit('queueStatus',{'position':i+1,'total':len(waiting_queue),
            'message':"You're next!" if i==0 else f"Position {i+1}"},to=u['sid'])

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
        sys_msg(rid,"You've been matched! 👋 Say hello.")
    push_q()

def enqueue(sid):
    m=socket_meta.get(sid,{})
    if any(u['sid']==sid for u in waiting_queue): return
    waiting_queue.append({'sid':sid,'nickname':m.get('nickname','User'),'avatar':m.get('avatar','🦊'),'join_time':time.time()})
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
def index(): return render_template('index.html',interests=INTERESTS,terms_version=TERMS_VERSION)

@app.route('/generate-captcha')
@limiter.limit("30 per minute")
def gen_captcha():
    cleanup()
    q,a=make_captcha()
    cid=''.join(random.choices(string.ascii_lowercase+string.digits,k=12))
    captcha_store[cid]={'answer':a,'expires':time.time()+CAPTCHA_TTL}
    return jsonify({'id':cid,'question':q})

@app.route('/verify-captcha',methods=['POST'])
@limiter.limit("20 per minute")
def verify_captcha():
    data=request.get_json(silent=True) or {}
    # Also require terms acceptance
    if not data.get('termsAccepted'):
        return jsonify({'success':False,'message':'You must accept the Terms & Conditions.'})
    entry=captcha_store.get(data.get('captchaId',''))
    if not entry or time.time()>entry['expires']:
        return jsonify({'success':False,'message':'Captcha expired. Refresh.'})
    try:
        if int(data.get('answer','x'))==entry['answer']:
            captcha_store.pop(data.get('captchaId'),None)
            return jsonify({'success':True})
    except: pass
    return jsonify({'success':False,'message':'Wrong answer. Try again.'})

@app.route('/health')
def health():
    return jsonify({'status':'ok','async_mode':ASYNC_MODE,'connections':len(socket_meta),
        'rooms':len(rooms),'queue':len(waiting_queue),'pairs':len(active_pairs)//2,
        'messages':perf['total_messages'],'uptime_s':round(time.time()-perf['start_time'])})

# ── Socket events ─────────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    sid=request.sid; ip=get_ip()
    if len(socket_meta)>=MAX_CONNECTIONS:
        emit('error',{'msg':'Server full.'}); return False
    cnt=connection_limiter.get(ip,0)
    if cnt>=MAX_CONNECTIONS_PER_IP:
        emit('error',{'msg':'Too many connections from your network.'}); return False
    connection_limiter[ip]=cnt+1
    nick=rnd_name(); avatar=rnd_avatar()
    socket_meta[sid]={'nickname':nick,'avatar':avatar,'room':None,'ip':ip,
        'joined_at':time.time(),'msg_count':0,'reactions':0}
    perf['total_connections']+=1; perf['peak_connections']=max(perf['peak_connections'],len(socket_meta))
    emit('welcome',{'nickname':nick,'avatar':avatar,'interests':INTERESTS,'online':len(socket_meta)})
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
    if room: sys_msg(room,f"{nick} left the chat"); remove_from_room(sid)
    socketio.emit('onlineCount',{'count':len(socket_meta)})
    log.info(f"🔌 {nick} disconnected | total={len(socket_meta)}")

@socketio.on('joinMode')
def on_join_mode(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    if isinstance(data,dict): mode=data.get('mode','random'); param=(data.get('param') or '').strip()[:30]
    else: mode=str(data); param=''
    # Sanitize param
    param = re.sub(r'[^a-zA-Z0-9_\-]','',param)
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    if   mode=='random':              room_key='global_random'
    elif mode=='room'    and param:   room_key=f"room_{param.lower()}"
    elif mode=='interest' and param:  room_key=f"interest_{param.lower()}"
    else:                             room_key='global_random'
    add_to_room(sid,room_key)
    sys_msg(room_key,f"{meta['nickname']} joined 👋")
    code=next((c for c,rk in room_codes.items() if rk==room_key),None)
    emit('joinedRoom',{'room':room_key,'userCount':len(rooms.get(room_key,set())),
        'code':code,'isOwner':code_owners.get(room_key)==sid})

@socketio.on('createCodedRoom')
def on_create_coded():
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    code=gen_code(); room_key=f"coded_{code}"
    room_codes[code]=room_key; code_owners[room_key]=sid
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    add_to_room(sid,room_key)
    sys_msg(room_key,f"🔐 Private room created! Share code: {code}")
    emit('joinedRoom',{'room':room_key,'userCount':1,'code':code,'isOwner':True})

@socketio.on('joinByCode')
def on_join_by_code(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    code=str(data.get('code','')).strip()
    if not re.match(r'^\d{5}$',code):
        emit('codeError',{'message':'Must be 5 digits.'}); return
    room_key=room_codes.get(code)
    if not room_key:
        emit('codeError',{'message':'Room not found. Check the code.'}); return
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    add_to_room(sid,room_key)
    sys_msg(room_key,f"{meta['nickname']} joined 🔑")
    emit('joinedRoom',{'room':room_key,'userCount':len(rooms.get(room_key,set())),'code':code,'isOwner':False})

@socketio.on('join1v1')
def on_join_1v1():
    sid=request.sid
    if not socket_meta.get(sid): return
    remove_from_room(sid); enqueue(sid)

@socketio.on('skip1v1')
def on_skip():
    sid=request.sid
    if sid in active_pairs:
        partner=active_pairs[sid]['partner_id']; end_pair(sid,skipped=True)
        enqueue(sid); enqueue(partner)

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
    msg = sanitize_message(raw)
    if not check_rate(sid):
        emit('notice',{'type':'warn','msg':'⚠️ Slow down! Too many messages.'}); return
    ok, reason = valid_msg(msg)
    if not ok:
        if reason=='too_long': emit('notice',{'type':'warn','msg':f'Message too long (max {MAX_MSG_LEN} chars).'})
        else: emit('notice',{'type':'error','msg':'Message not allowed.'})
        return
    room=meta.get('room')
    if not room: emit('notice',{'type':'error','msg':'Join a room first!'}); return
    meta['msg_count']+=1
    if room in room_stats: room_stats[room]['total_messages']+=1; room_stats[room]['last_activity']=time.time()
    perf['total_messages']+=1
    # NEVER echo sender's session ID, IP, or any identifiable data
    socketio.emit('chat message',{
        'nickname':meta['nickname'],
        'avatar'  :meta['avatar'],
        'msg'     :msg[:MAX_MSG_LEN],
        'timestamp':ts(),
        'type'    :'user',
        'msgId'   :''.join(random.choices(string.ascii_lowercase+string.digits,k=8)),
    }, to=room)

@socketio.on('reaction')
def on_reaction(data):
    """Send an emoji reaction to the room."""
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    room=meta.get('room')
    if not room: return
    emoji=str(data.get('emoji',''))
    ALLOWED_REACTIONS=['👍','❤️','😂','😮','😢','🔥','👏','💯']
    if emoji not in ALLOWED_REACTIONS: return
    meta['reactions']+=1
    socketio.emit('reaction',{'emoji':emoji,'from':meta['nickname']},to=room)

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
    log.info(f"🚀 Hideout running → http://0.0.0.0:{port}  [{ASYNC_MODE}]")
    socketio.run(app,host='0.0.0.0',port=port,debug=False,allow_unsafe_werkzeug=True)