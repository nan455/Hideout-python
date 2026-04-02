import os
import time
import random
import string
import logging
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger(__name__)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'change-me-in-production')

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet',
    ping_timeout=60, ping_interval=25, max_http_buffer_size=1_000_000,
    logger=False, engineio_logger=False)

limiter = Limiter(key_func=get_remote_address, app=app,
    default_limits=["200 per 15 minutes"], storage_uri="memory://")

MAX_CONNECTIONS=2000; MAX_CONNECTIONS_PER_IP=5
MESSAGE_RATE_LIMIT=20; RATE_WINDOW=60; MAX_MSG_LEN=500
CAPTCHA_TTL=300; CLEANUP_INTERVAL=120

ADJECTIVES=["Silent","Wild","Happy","Crazy","Mysterious","Swift","Noble","Brave","Clever","Gentle","Fierce","Wise","Bold","Quick","Calm","Bright","Cool","Smart","Lucky","Strong","Free","Kind","Pure","True","Dark","Cyber","Neon","Cosmic","Lunar","Solar","Arctic","Storm","Shadow"]
ANIMALS=["Fox","Wolf","Eagle","Panda","Tiger","Lion","Bear","Hawk","Owl","Deer","Lynx","Raven","Snake","Shark","Whale","Dolphin","Phoenix","Dragon","Griffin","Falcon","Jaguar","Panther","Cobra","Viper","Mantis","Badger","Coyote","Osprey","Mamba","Gecko","Orca","Hawk"]
AVATARS=["🦊","🐺","🦅","🐼","🐯","🦁","🐻","🦆","🦉","🦌","🐱","🐦","🐍","🦈","🐋","🐬","🔥","🐉","⚡","🌙","💫","🌟","🎭","🎪","👾","🤖","👻","💀","🎯","🌈","🦋","🐙"]
INTERESTS=["gaming","music","movies","sports","tech","anime","travel","art","books","food","fitness","crypto","science","fashion"]
BAD_WORDS={'spam','hack','phish','scam'}

connection_limiter={}; message_rates={}; captcha_store={}
rooms={}; user_rooms={}; room_stats={}
room_codes={}; code_owners={}
waiting_queue=[]; active_pairs={}; pair_counter=[0]
socket_meta={}; banned_ips=set(); last_cleanup=[time.time()]
perf={'start_time':time.time(),'total_connections':0,'total_messages':0,'peak_connections':0}

def random_name(): return f"{random.choice(ADJECTIVES)}{random.choice(ANIMALS)}{random.randint(100,999)}"
def random_avatar(): return random.choice(AVATARS)

def make_captcha():
    n1,n2=random.randint(1,20),random.randint(1,20)
    op=random.choice(['+','-','*'])
    if op=='+': return f"{n1} + {n2}",n1+n2
    elif op=='-':
        a,b=max(n1,n2),min(n1,n2); return f"{a} - {b}",a-b
    else:
        s1,s2=random.randint(1,10),random.randint(1,10); return f"{s1} × {s2}",s1*s2

def is_valid_message(msg):
    if not msg or not isinstance(msg,str): return False
    if len(msg)>MAX_MSG_LEN or not msg.strip(): return False
    return not any(w in msg.lower() for w in BAD_WORDS)

def check_rate(sid):
    now=time.time()
    r=message_rates.setdefault(sid,{'count':0,'reset_time':now+RATE_WINDOW})
    if now>r['reset_time']: r['count'],r['reset_time']=0,now+RATE_WINDOW
    if r['count']>=MESSAGE_RATE_LIMIT: return False
    r['count']+=1; return True

def ts(): return int(time.time()*1000)

def sys_msg(room,text):
    socketio.emit('chat message',{'nickname':'System','avatar':'🔒','msg':text,'timestamp':ts(),'type':'system'},to=room)

def generate_room_code():
    while True:
        code=str(random.randint(10000,99999))
        if code not in room_codes: return code

def maybe_cleanup():
    now=time.time()
    if now-last_cleanup[0]<CLEANUP_INTERVAL: return
    last_cleanup[0]=now
    for k in [k for k,v in captcha_store.items() if now>v['expires']]: captcha_store.pop(k,None)
    for k in [k for k,v in message_rates.items() if now>v['reset_time']+RATE_WINDOW*2]: message_rates.pop(k,None)

def add_to_room(sid,room_key):
    remove_from_room(sid)
    rooms.setdefault(room_key,set())
    room_stats.setdefault(room_key,{'created':time.time(),'max_users':0,'total_messages':0,'last_activity':time.time()})
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
            for code,rk in list(room_codes.items()):
                if rk==room_key: room_codes.pop(code,None); code_owners.pop(room_key,None)
    if sid in socket_meta: socket_meta[sid]['room']=None

def push_queue_update():
    for i,u in enumerate(waiting_queue):
        socketio.emit('queueStatus',{'position':i+1,'total':len(waiting_queue),'message':"You're next!" if i==0 else f"Position {i+1}"},to=u['sid'])

def run_match():
    while len(waiting_queue)>=2:
        u1=waiting_queue.pop(0); u2=waiting_queue.pop(0)
        pair_counter[0]+=1; rid=f"pair_{pair_counter[0]}_{int(time.time())}"
        active_pairs[u1['sid']]={'room_id':rid,'partner_id':u2['sid'],'partner_name':u2['nickname'],'partner_avatar':u2['avatar']}
        active_pairs[u2['sid']]={'room_id':rid,'partner_id':u1['sid'],'partner_name':u1['nickname'],'partner_avatar':u1['avatar']}
        for sid in (u1['sid'],u2['sid']):
            socketio.server.enter_room(sid,rid)
            if sid in socket_meta: socket_meta[sid]['room']=rid
        socketio.emit('matched',{'partnerName':u2['nickname'],'partnerAvatar':u2['avatar'],'roomId':rid},to=u1['sid'])
        socketio.emit('matched',{'partnerName':u1['nickname'],'partnerAvatar':u1['avatar'],'roomId':rid},to=u2['sid'])
        sys_msg(rid,"You've been matched! 👋 Say hello.")
    push_queue_update()

def enqueue(sid):
    m=socket_meta.get(sid,{})
    if any(u['sid']==sid for u in waiting_queue): return
    waiting_queue.append({'sid':sid,'nickname':m.get('nickname','User'),'avatar':m.get('avatar','🦊'),'join_time':time.time()})
    socketio.emit('queueStatus',{'position':len(waiting_queue),'total':len(waiting_queue),'message':'Looking for a partner…'},to=sid)
    run_match()

def dequeue(sid):
    global waiting_queue
    before=len(waiting_queue); waiting_queue=[u for u in waiting_queue if u['sid']!=sid]
    if len(waiting_queue)<before: push_queue_update()

def end_pair(sid,skipped=False):
    info=active_pairs.pop(sid,None)
    if not info: return
    partner=info['partner_id']; active_pairs.pop(partner,None); rid=info['room_id']
    nick=socket_meta.get(sid,{}).get('nickname','Partner')
    msg="Your partner skipped." if skipped else f"{nick} disconnected."
    socketio.emit('partnerLeft',{'message':msg},to=partner)
    for s in (sid,partner):
        try: socketio.server.leave_room(s,rid)
        except: pass
        if s in socket_meta: socket_meta[s]['room']=None

@app.route('/')
def index(): return render_template('index.html',interests=INTERESTS)

@app.route('/generate-captcha')
@limiter.limit("30 per minute")
def gen_captcha():
    maybe_cleanup()
    q,a=make_captcha()
    cid=''.join(random.choices(string.ascii_lowercase+string.digits,k=10))
    captcha_store[cid]={'answer':a,'expires':time.time()+CAPTCHA_TTL}
    return jsonify({'id':cid,'question':q})

@app.route('/verify-captcha',methods=['POST'])
@limiter.limit("20 per minute")
def verify_captcha():
    data=request.get_json(silent=True) or {}
    cid=data.get('captchaId',''); ans=data.get('answer','')
    entry=captcha_store.get(cid)
    if not entry or time.time()>entry['expires']: return jsonify({'success':False,'message':'Captcha expired.'})
    try:
        if int(ans)==entry['answer']: captcha_store.pop(cid,None); return jsonify({'success':True})
    except: pass
    return jsonify({'success':False,'message':'Wrong answer. Try again.'})

@app.route('/health')
def health():
    return jsonify({'status':'ok','connections':len(socket_meta),'rooms':len(rooms),
        'queue':len(waiting_queue),'pairs':len(active_pairs)//2,'messages':perf['total_messages']})

@socketio.on('connect')
def on_connect():
    sid=request.sid; ip=request.remote_addr
    if ip in banned_ips or len(socket_meta)>=MAX_CONNECTIONS: return False
    cnt=connection_limiter.get(ip,0)
    if cnt>=MAX_CONNECTIONS_PER_IP: emit('error',{'msg':'Too many connections.'}); return False
    connection_limiter[ip]=cnt+1
    nick=random_name(); avatar=random_avatar()
    socket_meta[sid]={'nickname':nick,'avatar':avatar,'room':None,'ip':ip,'joined_at':time.time(),'msg_count':0}
    perf['total_connections']+=1; perf['peak_connections']=max(perf['peak_connections'],len(socket_meta))
    emit('welcome',{'nickname':nick,'avatar':avatar,'interests':INTERESTS,'online':len(socket_meta)})
    log.info(f"🔗 {nick} connected | total={len(socket_meta)}")

@socketio.on('disconnect')
def on_disconnect():
    sid=request.sid; meta=socket_meta.pop(sid,{}); nick=meta.get('nickname','Unknown'); ip=meta.get('ip')
    if ip:
        cnt=connection_limiter.get(ip,1)
        if cnt>1: connection_limiter[ip]=cnt-1
        else: connection_limiter.pop(ip,None)
    message_rates.pop(sid,None); dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    room=user_rooms.get(sid)
    if room: sys_msg(room,f"{nick} left the chat"); remove_from_room(sid)
    log.info(f"🔌 {nick} disconnected | total={len(socket_meta)}")

@socketio.on('joinMode')
def on_join_mode(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    if isinstance(data,dict): mode=data.get('mode','random'); param=(data.get('param') or '').strip()[:30]
    else: mode=str(data); param=''
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    if mode=='random': room_key='global_random'
    elif mode=='room' and param: room_key=f"room_{param.lower().replace(' ','_')}"
    elif mode=='interest' and param: room_key=f"interest_{param.lower()}"
    else: room_key='global_random'
    add_to_room(sid,room_key)
    sys_msg(room_key,f"{meta['nickname']} joined 👋")
    code=next((c for c,rk in room_codes.items() if rk==room_key),None)
    emit('joinedRoom',{'room':room_key,'userCount':len(rooms.get(room_key,set())),'code':code,'isOwner':code_owners.get(room_key)==sid})
    log.info(f"📥 {meta['nickname']} → {room_key}")

@socketio.on('createCodedRoom')
def on_create_coded_room():
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    code=generate_room_code(); room_key=f"coded_{code}"
    room_codes[code]=room_key; code_owners[room_key]=sid
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    add_to_room(sid,room_key)
    sys_msg(room_key,f"🔐 Private room created! Your code: {code}")
    emit('joinedRoom',{'room':room_key,'userCount':1,'code':code,'isOwner':True})
    log.info(f"🔐 {meta['nickname']} created coded room {code}")

@socketio.on('joinByCode')
def on_join_by_code(data):
    sid=request.sid; meta=socket_meta.get(sid)
    if not meta: return
    code=str(data.get('code','')).strip()
    if not code.isdigit() or len(code)!=5:
        emit('codeError',{'message':'Invalid code. Must be 5 digits.'}); return
    room_key=room_codes.get(code)
    if not room_key:
        emit('codeError',{'message':'Room not found. Check code and try again.'}); return
    dequeue(sid)
    if sid in active_pairs: end_pair(sid)
    add_to_room(sid,room_key)
    sys_msg(room_key,f"{meta['nickname']} joined with code 🔑")
    emit('joinedRoom',{'room':room_key,'userCount':len(rooms.get(room_key,set())),'code':code,'isOwner':False})
    log.info(f"🔑 {meta['nickname']} joined coded room {code}")

@socketio.on('join1v1')
def on_join_1v1():
    sid=request.sid
    if not socket_meta.get(sid): return
    remove_from_room(sid); enqueue(sid)

@socketio.on('skip1v1')
def on_skip_1v1():
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
    msg=(data if isinstance(data,str) else data.get('msg','')).strip()
    if not check_rate(sid): emit('notice',{'type':'warn','msg':'⚠️ Too many messages. Slow down.'}); return
    if not is_valid_message(msg): emit('notice',{'type':'error','msg':'Message blocked.'}); return
    room=meta.get('room')
    if not room: emit('notice',{'type':'error','msg':'Join a room first!'}); return
    meta['msg_count']+=1
    if room in room_stats: room_stats[room]['total_messages']+=1; room_stats[room]['last_activity']=time.time()
    perf['total_messages']+=1
    socketio.emit('chat message',{'nickname':meta['nickname'],'avatar':meta['avatar'],'msg':msg[:MAX_MSG_LEN],'timestamp':ts(),'type':'user'},to=room)

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
    log.info(f"🚀 Hideout Chat v3 running on http://0.0.0.0:{port}")
    socketio.run(app,host='0.0.0.0',port=port,debug=False)